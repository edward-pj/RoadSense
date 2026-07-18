"""Train the gate + classifier models and export static-shape ONNX.

Usage:
  python tools/train.py --data data/roadsense_v1.csv --out models/
  python tools/train.py --synthetic --out models/   # bootstrap without real data

Real data CSV columns: label, then 128x6 flattened samples (ax0..gz127).
Labels: smooth=0, pothole=1, speed_breaker=2, rough_patch=3.

Exports (opset 17, static shapes — required for clean NPU compilation):
  models/gate.onnx        ~10k params, binary event/noise  -> DSP v66 via QAIRT
  models/classifier.onnx  ~60k params, 4-class + severity  -> NPU v73/v81 via AI Hub

Keep the architecture boring: Conv1D/BN/ReLU/Dense only. LSTM/attention/custom
ops risk silent CPU fallback on Hexagon.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np

WINDOW, CHANNELS, N_CLASSES = 16, 6, 4


def build_models():
    """Gate (binary) and classifier (4-class + severity head)."""
    import torch.nn as nn

    class Gate(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.net = nn.Sequential(
                nn.Conv1d(CHANNELS, 8, 3, stride=2, padding=1), nn.BatchNorm1d(8), nn.ReLU(),
                nn.Conv1d(8, 16, 3, stride=2, padding=1), nn.BatchNorm1d(16), nn.ReLU(),
                nn.AdaptiveAvgPool1d(1), nn.Flatten(),
                nn.Linear(16, 1), nn.Sigmoid(),
            )

        def forward(self, x):
            return self.net(x)

    class Classifier(nn.Module):
        def __init__(self) -> None:
            super().__init__()
            self.backbone = nn.Sequential(
                nn.Conv1d(CHANNELS, 16, 3, stride=2, padding=1), nn.BatchNorm1d(16), nn.ReLU(),
                nn.Conv1d(16, 32, 3, stride=2, padding=1), nn.BatchNorm1d(32), nn.ReLU(),
                nn.Conv1d(32, 64, 3, stride=2, padding=1), nn.BatchNorm1d(64), nn.ReLU(),
                nn.AdaptiveAvgPool1d(1), nn.Flatten(),
                nn.Linear(64, 32), nn.ReLU(),
            )
            self.cls_head = nn.Linear(32, N_CLASSES)
            self.sev_head = nn.Sequential(nn.Linear(32, 1), nn.Sigmoid())

        def forward(self, x):
            z = self.backbone(x)
            return self.cls_head(z), self.sev_head(z)

    return Gate(), Classifier()


def synthetic_dataset(n: int = 2000, seed: int = 7) -> tuple[np.ndarray, np.ndarray]:
    """Physics-flavoured synthetic windows so the pipeline is trainable
    before real drive data lands. Clearly not a substitute for real data."""
    rng = np.random.default_rng(seed)
    X = rng.normal(0, 0.03, (n, WINDOW, CHANNELS)).astype(np.float32)
    X[:, :, 2] += 1.0  # gravity
    y = rng.integers(0, N_CLASSES, n)
    t = np.arange(WINDOW)
    for i, label in enumerate(y):
        if label == 1:      # pothole: sharp dip then rebound at centre
            X[i, 6:10, 2] -= 0.8 * np.hanning(4)
            X[i, 8:12, 2] += 0.5 * np.hanning(4)
        elif label == 2:    # speed breaker: slow symmetric hump
            X[i, :, 2] += 0.45 * np.exp(-((t - 8) ** 2) / 5)
        elif label == 3:    # rough patch: sustained wideband vibration
            X[i, :, 2] += rng.normal(0, 0.18, WINDOW)
    return X, y.astype(np.int64)


def train_and_export(X: np.ndarray, y: np.ndarray, out: Path, epochs: int) -> None:
    import torch
    from torch.utils.data import DataLoader, TensorDataset

    gate, clf = build_models()
    xt = torch.from_numpy(X.transpose(0, 2, 1))  # (n, 6, 128)
    yt = torch.from_numpy(y)
    sev = (yt != 0).float().unsqueeze(1)  # crude severity proxy for synthetic
    dl = DataLoader(TensorDataset(xt, yt, sev), batch_size=64, shuffle=True)

    opt = torch.optim.Adam(list(clf.parameters()) + list(gate.parameters()), lr=1e-3)
    for epoch in range(epochs):
        correct = total = 0
        for xb, yb, sb in dl:
            opt.zero_grad()
            logits, sev_pred = clf(xb)
            loss = (torch.nn.functional.cross_entropy(logits, yb)
                    + torch.nn.functional.mse_loss(sev_pred, sb)
                    + torch.nn.functional.binary_cross_entropy(gate(xb), sb))
            loss.backward()
            opt.step()
            correct += (logits.argmax(1) == yb).sum().item()
            total += len(yb)
        print(f"epoch {epoch + 1}/{epochs} acc={correct / total:.3f}")

    out.mkdir(parents=True, exist_ok=True)
    dummy = torch.zeros(1, CHANNELS, WINDOW)
    for model, name, outputs in ((gate, "gate", ["event_prob"]),
                                 (clf, "classifier", ["logits", "severity"])):
        model.eval()
        torch.onnx.export(model, dummy, str(out / f"{name}.onnx"),
                          input_names=["window"], output_names=outputs,
                          opset_version=17, dynamo=False)
        print(f"exported {out / f'{name}.onnx'}")

    # Calibration windows for INT8 quantization — MUST match the inference
    # distribution (AI Hub is explicit: random-noise calibration destroys accuracy).
    calib_dir = out.parent / "data" / "calibration"
    calib_dir.mkdir(parents=True, exist_ok=True)
    idx = np.random.default_rng(0).choice(len(X), min(100, len(X)), replace=False)
    np.save(calib_dir / "windows.npy", X[idx].transpose(0, 2, 1))
    print(f"saved {len(idx)} calibration windows -> {calib_dir / 'windows.npy'}")


def load_csv(path: Path) -> tuple[np.ndarray, np.ndarray]:
    raw = np.loadtxt(path, delimiter=",", skiprows=1)
    y = raw[:, 0].astype(np.int64)
    X = raw[:, 1:].reshape(-1, WINDOW, CHANNELS).astype(np.float32)
    return X, y


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, help="labelled CSV of real drives")
    ap.add_argument("--synthetic", action="store_true")
    ap.add_argument("--out", type=Path, default=Path("models"))
    ap.add_argument("--epochs", type=int, default=15)
    args = ap.parse_args()
    X, y = synthetic_dataset() if args.synthetic or not args.data else load_csv(args.data)
    if args.synthetic or not args.data:
        csv_out = Path("data/synthetic_roadsense.csv")
        csv_out.parent.mkdir(parents=True, exist_ok=True)
        out_data = np.column_stack((y, X.reshape(X.shape[0], -1)))
        np.savetxt(csv_out, out_data, delimiter=",", fmt="%g", header="label," + ",".join(f"f{i}" for i in range(X.shape[1]*X.shape[2])), comments="")
        print(f"Exported full synthetic dataset to {csv_out}")
    train_and_export(X, y, args.out, args.epochs)

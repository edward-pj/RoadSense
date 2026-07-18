import onnxruntime as ort
import numpy as np

# 1. Load the exported Classifier model
session = ort.InferenceSession("models/classifier.onnx")

# 2. Prepare your input (We will use fake random data here as an example)
# Shape is (Batch=1, Channels=6, TimeSteps=16)
np.random.seed(42) # Set seed for reproducible results
my_imu_data = np.random.randn(1, 6, 16).astype(np.float32)

# 3. Run the model! ("window" is the name of the input node we set during export)
outputs = session.run(None, {"window": my_imu_data})

# 4. Extract the results
logits = outputs[0]      # The raw scores for the 4 classes
severity = outputs[1]    # A score between 0.0 and 1.0 indicating how bad the bump was

print("=== Inference Results ===")
print(f"Raw Class Scores (Logits): {logits[0]}")
# To get the predicted class, we take the index of the highest score
predicted_class = np.argmax(logits[0])
classes = ["Smooth Road", "Pothole", "Speed Breaker", "Rough Patch"]
print(f"Predicted Class: {predicted_class} ({classes[predicted_class]})")
print(f"Severity Score: {severity[0][0]:.4f}")

for i in range(1, 5):
    with open(f'cloud/dashboard/images/pothole_{i}.jpg', 'rb') as f:
        print(f'pothole_{i}.jpg:', f.read(10).hex())

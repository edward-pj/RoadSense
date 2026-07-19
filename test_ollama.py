import base64
import httpx
import asyncio

async def test():
    with open('cloud/dashboard/images/pothole_1.jpg', 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('utf-8')
    
    payload = {
        'model': 'llava',
        'prompt': 'What is this?',
        'stream': False,
        'images': [b64]
    }
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            resp = await client.post('http://localhost:11434/api/generate', json=payload)
            print("Status Code:", resp.status_code)
            print("Response:", resp.text)
        except Exception as e:
            print("Error connecting:", e)

asyncio.run(test())

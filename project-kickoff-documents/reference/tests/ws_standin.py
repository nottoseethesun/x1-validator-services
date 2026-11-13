"""Stand-in for the rpc's websocket port: logs each connection and echoes."""
import asyncio, sys, websockets
logf = sys.argv[1]
async def handler(ws):
    with open(logf, "a") as f:
        f.write(f"ws {ws.request.path}\n")
    async for msg in ws:
        await ws.send("echo:" + msg)
async def main():
    async with websockets.serve(handler, "127.0.0.1", 8900):
        await asyncio.Future()
asyncio.run(main())

"""Opens a websocket through nginx and prints the echoed reply, or the error."""
import asyncio, ssl, sys, websockets
async def main(url):
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        async with websockets.connect(url, ssl=ctx, host=sys.argv[2], port=443,
                                      server_hostname="x1-rpc.example.com", proxy=None) as ws:
            await ws.send('{"method":"slotSubscribe"}')
            print(await ws.recv())
    except Exception as e:
        print("refused:", type(e).__name__, str(e)[:80])
asyncio.run(main(sys.argv[1]))

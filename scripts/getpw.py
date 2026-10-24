import asyncio, sys, json
from roombapy.getpassword import RoombaPassword

IP = sys.argv[1]
async def main():
    for i in range(90):
        pw = await RoombaPassword(IP).get_password(timeout=3)
        if pw:
            print(pw, flush=True)
            return
        await asyncio.sleep(2)
    print("TIMEOUT", flush=True)
asyncio.run(main())

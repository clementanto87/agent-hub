import os
import pty
import select
import asyncio
import struct
import fcntl
import termios
import codecs
from fastapi import WebSocket

class TerminalManager:
    def __init__(self):
        self.sessions = {}

    async def handle_websocket(self, websocket: WebSocket, cwd: str = "/root"):
        await websocket.accept()
        master_fd, slave_fd = pty.openpty()

        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"

        pid = os.fork()
        if pid == 0:
            # Child process
            os.close(master_fd)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            os.close(slave_fd)
            if os.path.isdir(cwd):
                os.chdir(cwd)
            os.execvpe("/bin/bash", ["/bin/bash"], env)
        else:
            # Parent process
            os.close(slave_fd)
            loop = asyncio.get_event_loop()

            # Incremental so a multi-byte character split across reads isn't garbled.
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

            def write_all(data: bytes):
                # os.write on a pty can be partial (big pastes), so loop until done.
                while data:
                    n = os.write(master_fd, data)
                    data = data[n:]

            async def read_from_pty():
                try:
                    while True:
                        data = await loop.run_in_executor(None, os.read, master_fd, 65536)
                        if not data:
                            break
                        text = decoder.decode(data)
                        if text:
                            await websocket.send_text(text)
                except Exception:
                    pass

            read_task = asyncio.create_task(read_from_pty())

            try:
                while True:
                    msg = await websocket.receive_text()
                    if msg.startswith("__RESIZE__:"):
                        try:
                            _, rows, cols = msg.split(":")
                            winsize = struct.pack("HHHH", int(rows), int(cols), 0, 0)
                            fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                        except Exception:
                            pass
                    else:
                        await loop.run_in_executor(None, write_all, msg.encode("utf-8"))
            except Exception:
                pass
            finally:
                read_task.cancel()
                try:
                    os.close(master_fd)
                except Exception:
                    pass
                try:
                    os.kill(pid, 9)
                    os.waitpid(pid, 0)
                except Exception:
                    pass

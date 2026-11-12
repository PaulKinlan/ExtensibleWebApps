---
# No inbox: it only runs its command, so an editor can't talk to it.
id: stamper
name: Stamper
model: fast
permissions: [data:read:library]
on:
  - command: stamp
---
When asked to `stamp`, list the books and say how many there are.

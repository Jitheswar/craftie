# Craftie: an AI coworker for Minecraft

Craftie is a second player that joins your Minecraft world and plays **with** you. Ask it for something in chat (*"build me a house"*, *"get 20 iron"*, *"make me armor"*) and it works out every step itself: chopping trees, making tools, mining, smelting, crafting, building.

When you don't need it, it doesn't just stand around. It follows you, watches your back, and keeps itself stocked with food, tools and armor, like a good teammate.

> Craftie is a fan project. It is not affiliated with Mojang or Microsoft.

---

## What it can do

**Do jobs for you**
- *"build me a house"*: gathers every material and builds a proper cottage: stone base, log pillars, glass windows, pitched stair roof, door, torches, crafting table, furnace and chest.
- *"get 20 iron"*, *"make me an iron pickaxe"*: figures out the whole chain (which tool it needs first, where to mine, what to smelt) and does it.
- Simple orders like *"come here"*, *"follow me"* or *"kill that zombie"* happen instantly.

**Look after you**
- Follows you at a safe distance, walking, swimming, pillaring up after you, or flying with you in creative.
- Defends you: anyone who attacks you (mob or player) gets dealt with.
- If you die, it picks up your items before they vanish and gives them back when you ask.
- When you go to bed, it sleeps in a bed next to yours, so the night skips and you respawn together.

**Look after itself**
- Keeps itself fed, armed and equipped (always wearing its best armor and holding its best weapon), and crafts its own bed.
- Notices valuables: grabs nearby diamonds, emeralds and good loot by itself. If a find is deep or risky, it tells you where instead of wandering off.
- Stores extra items in a chest by your bed, and takes only what a job needs.
- If it dies, it goes back for its things and carries on with what it was doing.

**Talk like a teammate**
- Answers questions in short, one-line replies that fit Minecraft chat.
- Remembers things across sessions: *"what were you doing?"*, *"where did you put the iron?"*, *"what kind of houses do I like?"*.
- Private chat: `/msg Craftie …` keeps the conversation between the two of you.

Only **you** can give Craftie orders. Everyone else is ignored.

---

## Getting started

**You need:** Minecraft Java Edition and a computer to run Craftie on. (Linux is what it's built and tested on.)

1. Download this project and run `./start.sh`. The first time, it downloads what it needs by itself.
2. A setup page opens in your browser. Fill in:
   - your Minecraft name,
   - which AI to use (see below),
   - optionally, a TypeSafe Jev key for speed.
3. Tick **"Start Craftie when I log in"**. That's it. From now on Craftie runs quietly in the background and joins whenever you play.

**To play together:** open any world and open it to LAN with **Online Mode off**. That's easiest with the included **Craftie Auto LAN** mod (below), which does it for you. Craftie joins within a few seconds.

### Talking to Craftie

Start a chat message with its name: `craftie …`, `!craftie …`, `@craftie …` or `!ai …`.

| Say | What happens |
|---|---|
| `craftie, build me a house` | gathers everything and builds it |
| `craftie get 20 iron` | makes the tools it needs, mines, smelts |
| `craftie come here` / `follow me` / `stay` | instant |
| `craftie give me my stuff back` | returns the items it saved when you died |
| `craftie what were you doing?` | answers from its memory |
| `craftie relax` / `get to work` | turns its own chores off and on |
| `craftie pause` / `resume` | stops all AI use to save your usage (following and fighting still work) |
| `craftie settings` | opens the settings page |
| `craftie restart` | restarts Craftie (it rejoins in a few seconds) |
| `/msg Craftie …` | private conversation |

---

## Which AI does it use?

Pick whichever you have:

- **Claude** or **ChatGPT/Codex** subscription (through their apps on your computer)
- **API keys:** Claude, OpenAI, OpenRouter, DeepSeek
- **Free local AI:** Ollama or LM Studio

**Optional speed boost: [TypeSafe Jev](https://typesafe.ai).** It answers simple orders in about a third of a second, notices when a step of a job went wrong so it can be fixed on the spot, and spots plain chat so a smaller, cheaper prompt is used.

**Saving usage:** following, fighting, chores, rescues and simple commands are plain code and use **no AI at all**. Only planning and chatting do. If your AI hits a usage limit, Craftie pauses its AI by itself and keeps doing everything else.

---

## Optional game mods (Fabric)

| Mod | What it does |
|---|---|
| **Craftie Auto LAN** (in [`mods/`](mods/)) | Opens every world to LAN with Online Mode off as soon as you load it, so Craftie joins with no clicks. Ready-made jars for 1.20.1, 1.20.4, 1.21.1 and 1.21.4 are in `mods/builds/`. |
| **[CustomSkinLoader](https://modrinth.com/mod/customskinloader)** | Gives Craftie a skin in your game: put a skin at `CustomSkinLoader/LocalSkin/skins/Craftie.png` in your game folder. |

Neither mod affects friends joining your world.

---

## Privacy and safety

- **API keys** are encrypted on your computer (`~/.craftie/vault.json`) with a key tied to your PC and user account. They're never written to settings files, logs or the web page.
- **The settings page** only works on your own computer, behind a one-time secret link.
- **Memory** stays on your computer in a small local database (`~/.craftie/craftie.db`).
- **Online Mode off** means names aren't verified, so anyone who can reach your world could join under any name. Keep tunnel links (like e4mc's) private.
- Many public servers don't allow bots. Use Craftie in your own worlds or where it's welcome.

---

## How it works (for the curious)

- **The AI decides what to do.** Fast code does the doing: pathfinding, mining, crafting, building and fighting all run at game speed, so most jobs need only one AI call.
- **The planner** can get any item by working backwards through Minecraft's recipes, tools and drops.
- **The builder** turns a design into blocks: it checks materials, clears the site, places blocks with the right facing, and cleans up its scaffolding.
- **Jev** answers small yes/no and multiple-choice questions about each message and each step result. Code then decides what to do with those answers.
- **Memory** lives in SQLite with full-text search. Each request only carries the few pieces that matter right now, so it stays small however long you play.

Code map:

- `src/brain/`: agent, plan runner, Jev questions, memory
- `src/body/minecraft/`: connection, skills, planner, builder
- `src/core/`: settings, key vault, autostart
- `src/llm/`: AI backends
- `mods/`: the Auto LAN mod

**Built on:** [Mineflayer](https://github.com/PrismarineJS/mineflayer), [mineflayer-pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder) and friends, [Fabric](https://fabricmc.net/).

---

## Status

Craftie is young and being built actively.

**Works well:**
- following,
- fighting and defending,
- rescuing items,
- the planner,
- building in creative,
- memory,
- Jev routing.

**Still being polished:**
- big survival builds from scratch,
- build speed,
- testing the Auto LAN mod on 1.21+ in a real game.

**Not supported yet:**
- Bedrock Edition,
- servers that require client mods (Forge).

## License

[MIT](LICENSE): use it, change it, share it, with credit.

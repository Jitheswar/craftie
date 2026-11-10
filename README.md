# Craftie: an AI coworker for Minecraft

Craftie is a second player that joins your Minecraft world and plays **with** you. Ask it for something in chat (*"build me a house"*, *"get 20 iron"*, *"make me armor"*) and it works out every step itself: chopping trees, making tools, mining, smelting, crafting, building.

When you don't need it, it doesn't just stand around. It follows you, watches your back, and keeps itself stocked with food, tools and armor, like a good teammate.

> Craftie is a fan project. It is not affiliated with Mojang or Microsoft.

---

## What it can do

**Do jobs for you**
- *"build me a house"*: gathers every material and builds a proper cottage: stone base, log pillars, glass windows, pitched stair roof, door, torches, crafting table, furnace and chest.
- *"build my castle schematic"*: builds any WorldEdit (`.schem`) or Litematica (`.litematic`) file you drop into `~/.craftie/schematics/`. Ask for it by file name.
- *"build me a bridge"*, *"make a wheat farm"*: for things with no preset, the AI designs the build itself, layer by layer.
- *"get 20 iron"*, *"make me an iron pickaxe"*: figures out the whole chain (which tool it needs first, where to mine, what to smelt) and does it.
- Simple orders like *"come here"*, *"follow me"* or *"kill that zombie"* happen instantly.

**Look after you**
- Follows you at a safe distance and looks at you like a real player, walking straight to you, swimming at the surface, diving with you underwater, pillaring up after you, or flying beside you in creative.
- Gets itself unstuck: it breaks through whatever is boxing it in, but never breaks blocks *you* placed (it learns which ones are yours by watching you build).
- Copies your game mode: you switch to creative or survival, it does too (needs cheats on).
- Defends you: anyone who attacks you (mob or player) gets dealt with.
- If you die, it picks up your items before they vanish and gives them back when you ask.
- When you go to bed, it sleeps in a bed next to yours, so the night skips and you respawn together.

**Look after itself**
- Keeps itself fed, armed and equipped (always wearing its best armor and holding its best weapon), and crafts its own bed.
- Notices valuables: grabs nearby diamonds, emeralds and good loot by itself. If a find is deep or risky, it tells you where instead of wandering off.
- Stores extra items in a chest by your bed, and takes only what a job needs.
- If it dies, it goes back for its things and carries on with what it was doing.
- A full bag never stops a job: it stores extras or drops junk (dirt, gravel, rotten flesh) and keeps its tools and valuables.

**Talk like a teammate**
- Answers questions in short, one-line replies that fit Minecraft chat.
- Remembers things across sessions: *"what were you doing?"*, *"where did you put the iron?"*, *"what kind of houses do I like?"*.
- Private chat: `/msg Craftie …` keeps the conversation between the two of you.
- Has a personality of its own, and an adventure journal of what you've done together: first diamonds, close calls, rescues, builds. Edit its personality in `~/.craftie/personality.txt`.

**Work as a team**
- `craftie join` brings in a helper (Craftie1, then Craftie2, then Craftie3). `craftie exit` sends the newest one home, `craftie1 exit` sends that one, `craftie exit all` sends them all. Helpers come back on their own the next time you play.
- Helpers follow you (a little further back, so nobody crowds you), defend you, and never fight each other.
- Big projects are shared out: in *"build a village"*, each Craftie takes a different house, so they go up at the same time.
- Order a helper directly (`craftie1 get 32 oak_log`), through the main Craftie (`craftie tell craftie1 to mine stone`, `craftie have the helpers follow me`), or everyone at once (`team follow me`). On a big job, the main Craftie hands parts to free helpers by itself.

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
| `craftie build the tower schematic` | builds `~/.craftie/schematics/tower.schem` (or `.litematic`) |
| `craftie get 20 iron` | makes the tools it needs, mines, smelts |
| `craftie come here` / `follow me` / `stay` | instant |
| `craftie give me my stuff back` | returns the items it saved when you died |
| `craftie what were you doing?` | answers from its memory |
| `craftie join` / `craftie exit` | adds a helper Craftie / sends one home |
| `craftie tell craftie1 to …` | passes an order to a helper |
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
| **Craftie Auto LAN** (in [`mods/`](mods/)) | Opens every world to LAN with Online Mode off as soon as you load it, so Craftie joins with no clicks. On Minecraft 26.x it also adds a status panel (each Craftie's health, food, distance, direction and current job), an order box on the **G** key with quick buttons, the `/craftie <order>` command (orders go as private messages), and Craftie's own skin, which everyone in your world sees. Ready-made jars for 1.20.1, 1.20.4, 1.21.1, 1.21.4 and 26.3 are in `mods/builds/`. |
| **[CustomSkinLoader](https://modrinth.com/mod/customskinloader)** | Gives Craftie a skin in your game on versions before 26.x: put a skin at `CustomSkinLoader/LocalSkin/skins/Craftie.png` in your game folder. |

**Installing it:** step 4 of the setup page lists the Minecraft instances on your PC (Prism Launcher, MultiMC, PolyMC, and the standard `.minecraft` folder). Pick one and press **Install**; it also adds Fabric API if the instance doesn't have it. The mod needs the Fabric loader. Settings are in `config/craftie-autolan.properties` in the game folder, and the keys can be changed under Controls.

Only you need these mods. Friends install nothing, and neither mod affects them joining your world.

**Newer Minecraft than Craftie's library supports** (e.g. 26.3; it speaks up to 26.1): Craftie starts [ViaProxy](https://github.com/ViaVersion/ViaProxy) on its own and joins through it. It's downloaded once (about 50 MB) into `~/.craftie/viaproxy`, and it needs Java installed.

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
- **Following** steers directly toward you when you're close, like a person would. It only uses the pathfinder to climb or route around walls, and re-plans as soon as you move.
- **Diagnostics:** Craftie writes what it's doing (position, mode, who it follows, distance) to `~/.craftie/status.json` every few seconds.

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
- following: walking, climbing, swimming, diving and flying,
- fighting and defending,
- rescuing items,
- treasure sense,
- best gear,
- the planner,
- building in creative,
- memory,
- Jev routing,
- teams of up to 4 Crafties (`craftie join`),
- long-running projects (*"build a village"* is split into steps and carried on across sessions; `craftie project status` / `pause` / `resume` / `cancel`).

**Still being polished:**
- survival builds from scratch: Craftie gathers everything itself (about 50 logs and 36 stone for a small hut), which takes 20+ minutes from an empty inventory; with materials in its chests a hut takes a few minutes,
- testing the Auto LAN mod on 1.21+ in a real game.

**Not supported yet:**
- Bedrock Edition,
- servers that require client mods (Forge).

## License

[MIT](LICENSE): use it, change it, share it, with credit.

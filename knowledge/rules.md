# Game rules

## Core rules
<!-- type: fact; tags: core; when: any; source: WinCheckExecution, AttackExecution, Config.troopIncreaseRate -->
- You win by holding more than 80% of the land. You are eliminated when you hold no land.
- An attack targets one player (or unclaimed land) and advances along your whole shared border with them. The troops you send leave your reserve. Attacks keep running on their own until their troops are spent: you do not need to repeat an order.
- Troops regenerate every tick, fastest at about 40% of your troop cap. The cap grows with territory and with cities.
- Gold accrues every tick. Cities raise the troop cap, ports earn trade gold, defense posts make nearby borders much harder to take. A first city costs 125,000 gold, a first defense post 50,000 (each further one costs more).
- Allies cannot attack each other. Boats carry troops over water to a coastal tile.

## Time
<!-- type: fact; tags: core; when: any; source: Config.msPerTick, GameImpl.executeNextTick -->
The game runs at 10 ticks per second. You are asked for orders every few seconds of game time; the game waits while you think. An order is applied at the next tick.

## Spawn
<!-- type: fact; tags: spawn; when: spawn; source: SpawnExecution, Config.spawnImmunityDuration -->
Against the AI (singleplayer), the game starts as soon as you pick your spawn: you get a small patch of land around the chosen tile. For the first 5 seconds after that, you cannot attack nations, who are still immune.

## Kinds of opponents
<!-- type: fact; tags: nations, tribes, attack; when: any; source: Config.maxTroops, Config.troopIncreaseRate, EngineConfig.startManpower, EngineConfig.attackLogic -->
Nations are the game's strong AI: at Medium difficulty they start with 18,750 troops and get 75% of a human's troop cap. Tribes are weak: a third of the troop cap, half the troop growth, half the gold, 10,000 starting troops, and they attack with only 1/20 of their troops. You lose 30% fewer troops when attacking a tribe. You start with 25,000 troops.

## Conquest
<!-- type: fact; tags: attack, economy; when: mid, late; source: EngineConfig.conquerGoldAmount -->
When you eliminate a tribe or a nation, you take all of its gold.

## Victory
<!-- type: fact; tags: win; when: late; source: WinCheckExecution, Config.percentageTilesOwnedToWin -->
The game ends as soon as one player holds more than 80% of the land. Every other player is then ranked by land.

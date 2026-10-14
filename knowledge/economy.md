# Economy

## Gold income
<!-- type: fact; tags: economy; when: any; source: EngineConfig.goldAdditionRate -->
You earn 100 gold per tick (1,000 per second) from the start, whatever the size of your territory; tribes earn half. Extra gold comes from trade ships, trains and conquest.

## Troop cap and growth
<!-- type: fact; tags: economy, troops; when: any; source: Config.maxTroops, Config.cityTroopIncrease, Config.troopIncreaseRate -->
Your troop cap is 2 × (1000 × tiles^0.6 + 50,000), plus 250,000 per city level. Doubling your land raises the territory part by only about 50%, while each city adds a large fixed step. Growth is fastest at about 42% of the cap and stops at the cap.

## Building costs
<!-- type: fact; tags: build, economy; when: any; source: EngineConfig.unitCost, Config.unitInfo -->
- City: 125,000 gold, doubling with each city you own, capped at 1,000,000. Builds in 2 s.
- Port and factory share one counter: 125,000, doubling per port or factory owned, capped at 1,000,000.
- Defense post: 50,000 × (number owned + 1), capped at 250,000.
Buildings go on your own land, at least 15 tiles from your other buildings. A port must be on your coast.

## Ports and trade
<!-- type: fact; tags: economy, build, naval; when: mid, late; source: PortExecution, TradeShipExecution, PlayerImpl.canTrade -->
Ports send trade ships to other players' ports. When a ship arrives, both port owners earn gold, more for longer routes. Players who embargo each other do not trade.

## Factories
<!-- type: fact; tags: economy, build; when: mid, late; source: FactoryExecution, TrainStation -->
Factories create trains that run between your cities, ports and factories. Each stop earns gold for the train owner and the station owner.

## Cities first
<!-- type: strategy; tags: economy, build, troops; when: early, mid; status: to evaluate -->
Once the first expansion waves are out, spend gold on a city as soon as one is affordable. Each city adds 250,000 to the troop cap, which raises troop growth more than land does.

## Ports for trade
<!-- type: strategy; tags: economy, build, naval; when: mid; status: to evaluate -->
Build a port once you have a coast and a city: trade gold then helps pay for the next cities.

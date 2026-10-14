# Expansion

## Taking unclaimed land
<!-- type: fact; tags: expand, troops; when: early, mid; source: EngineConfig.attackLogic, EngineConfig.attackAmount -->
Expanding into unclaimed land costs troops for each tile taken: about 16 per plains tile, 20 per highland tile and 24 per mountain tile. The wave advances faster with a longer border and with more troops sent. It stops when its troops run out or no unclaimed land is left next to you. There is no fight: nobody defends unclaimed land.

## Terrain
<!-- type: fact; tags: expand, spawn; when: spawn, early; source: EngineConfig.terrainAttackBase -->
Plains are the cheapest and fastest terrain to take, highlands cost more, mountains the most (about 1.5× plains in troops and time).

## Boats
<!-- type: fact; tags: naval, expand, attack; when: any; source: EngineConfig.boatMaxNumber, TransportShipExecution -->
To reach land across water, send a transport ship with troops to a coastal tile. It leaves from your coast, so you need a coastline. You can have at most 3 transport ships at sea. On landing, the troops attack the tile's owner (or take unclaimed land) from the beach.

## Expand fast while land is free
<!-- type: strategy; tags: expand, troops; when: early; status: to evaluate -->
While unclaimed land borders you, keep an expansion running almost all the time. Free land costs a fixed, low price per tile, while land taken from players costs much more. Sending 20-40% of your troops per wave keeps the reserve growing.

## Keep troops near 40% of the cap
<!-- type: strategy; tags: troops, expand, attack; when: early, mid; status: to evaluate -->
Send troops when you are well above 40-50% of your cap: troops sitting at the cap are wasted growth. Avoid dropping far below 30%, since a low reserve invites attacks.

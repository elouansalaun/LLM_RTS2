# Combat

## How attacks on players resolve
<!-- type: fact; tags: attack, defend; when: any; source: EngineConfig.attackLogic -->
For every tile you take from a player, the defender loses its average troops per tile, and you lose troops that rise with that density. An attack larger than the defender's whole army pays less per tile (down to 0.6×); one facing an army twice its size or more pays double and advances up to 7.5 times slower. Low troops per tile means an easy target.

## Counter-attacks cancel
<!-- type: fact; tags: defend, attack; when: any; source: AttackExecution.init -->
When you attack a player who is attacking you, the two attacks cancel troop for troop. If yours is larger, theirs disappears and the rest of yours advances into their land.

## Defense posts
<!-- type: fact; tags: defend, build; when: mid, late; source: EngineConfig.defensePostDefenseBonus, Config.defensePostRange -->
Tiles within 30 tiles of your finished defense post are much harder to take: attackers lose 5 times more troops there and advance 3 times slower. A post costs 50,000 gold (more for each one you own) and takes 5 seconds to build.

## Traitors
<!-- type: fact; tags: attack, diplomacy; when: any; source: Config.traitorDuration, Config.traitorDefenseDebuff -->
A player who breaks an alliance is a traitor for 30 seconds: attackers lose half as many troops against them.

## Eat tribes first
<!-- type: strategy; tags: attack, tribes; when: early, mid; status: to evaluate -->
Once unclaimed land runs out, attack neighbouring tribes before nations. Tribes grow slowly, defend with few troops, and cost 30% fewer losses to attack.

## Weak targets, strong attacks
<!-- type: strategy; tags: attack, nations; when: mid, late; status: to evaluate -->
Attack neighbours with fewer troops than you and low troops per tile, and send enough to outnumber their whole army: one big attack pays less per tile and moves faster than many small ones.

## One war at a time
<!-- type: strategy; tags: attack, defend; when: mid, late; status: to evaluate -->
Fight one opponent at a time. Avoid starting a new war while you are being attacked on another front, except to counter-attack the attacker.

## Answer an incoming wave
<!-- type: strategy; tags: defend; when: any; status: to evaluate -->
When a land attack comes in and you have the troops, counter-attack the attacker with a bit more than the incoming wave. That cancels it and pushes into their land at a lower cost than letting it take your tiles.

## Fortify the dangerous front
<!-- type: strategy; tags: defend, build, nations; when: mid, late; status: to evaluate -->
Put defense posts on the border with the neighbour that has the most troops relative to you, not everywhere. Keep about a third of your cap in reserve while that neighbour is stronger.

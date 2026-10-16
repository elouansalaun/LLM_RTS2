# Diplomacy

## Alliances
<!-- type: fact; tags: diplomacy, nations; when: any; source: AllianceRequestExecution, Config.allianceRequestDuration, Config.allianceDuration -->
An alliance request expires after 20 seconds; you accept one by sending a request back. You can ask the same player again only after 30 seconds. Allies cannot attack each other. An alliance lasts 5 minutes, then expires unless both sides extend it.

## Tribes accept every alliance
<!-- type: fact; tags: diplomacy, tribes; when: any; source: TribeExecution.acceptAllAllianceRequests -->
A tribe accepts every alliance request it receives, and every extension. While you are allied with a tribe you cannot attack it.

## Side effects of attacking
<!-- type: fact; tags: diplomacy, attack, nations; when: any; source: AttackExecution.init, EngineConfig.temporaryEmbargoDuration -->
When you attack a nation, it embargoes you for 5 minutes (no trade between you) and rejects its pending alliance requests to you.

## How nations see you
<!-- type: fact; tags: diplomacy, nations; when: any; source: PlayerImpl.relation, NationExecution -->
Each nation keeps a relation towards you, from hostile to friendly. Alliances and donations improve it; attacks and embargoes worsen it. Nations use it to decide whom to ally with and whom to attack.

## Secure one front with an alliance
<!-- type: strategy; tags: diplomacy, nations, defend; when: early, mid; status: to evaluate -->
Propose an alliance to a stronger neighbour you cannot beat, so you can push against weaker ones without fighting on two fronts.

## Do not ally with your next meal
<!-- type: strategy; tags: diplomacy, tribes, attack; when: early, mid; status: to evaluate -->
An alliance with a tribe is free, but it protects the tribe from you. Ally only with tribes you will not need to attack, for example to keep a quiet border while you fight a nation elsewhere.

## Accept useful alliances
<!-- type: strategy; tags: diplomacy; when: any; status: to evaluate -->
Accept alliance requests from neighbours you are not planning to attack in the next few minutes: it removes a threat for free. Refuse (let expire) requests from the neighbour you plan to attack next.

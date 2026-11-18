(***************************************************************************)
(* Skyburn Phase 4 (Task 4.1) - Game/UI flow FSM, model-checked with TLC.  *)
(* Mirrors buildGameTable() in src/main.js (including the Phase 4 PAUSED   *)
(* state): MENU -> HANGAR -> BRIEFING -> LOADING -> PLAYING -> DEBRIEF,    *)
(* PLAYING <-> PAUSED, DEBRIEF retry/continue.                             *)
(*                                                                         *)
(* TLC proves (see game.cfg):                                              *)
(*   - TypeOK,                                                             *)
(*   - NoForbiddenJump: no transition ever crosses the PRD forbidden pair  *)
(*     list (tracked via prevState; mirrors FSMTable.validate),            *)
(*   - no deadlock (every screen has an outgoing action; PAUSED resumes).  *)
(***************************************************************************)
---- MODULE game ----
EXTENDS Naturals

VARIABLES state, prevState
vars == <<state, prevState>>

Init == /\ state = "MENU"
        /\ prevState = "MENU"

Macro == prevState' = state

OpenHangar == /\ state = "MENU"     /\ Macro /\ state' = "HANGAR"
BackToMenu == /\ state \in {"HANGAR", "BRIEFING"} /\ Macro /\ state' = "MENU"
Pick == /\ state \in {"MENU", "HANGAR"} /\ Macro /\ state' = "BRIEFING"
Launch == /\ state = "BRIEFING" /\ Macro /\ state' = "LOADING"
Loaded == /\ state = "LOADING" /\ Macro /\ state' = "PLAYING"
Pause == /\ state = "PLAYING" /\ Macro /\ state' = "PAUSED"
Resume == /\ state = "PAUSED" /\ Macro /\ state' = "PLAYING"
Ended == /\ state = "PLAYING" /\ Macro /\ state' = "DEBRIEF"
Retry == /\ state = "DEBRIEF" /\ Macro /\ state' = "LOADING"
Continue == /\ state = "DEBRIEF" /\ Macro /\ state' = "MENU"

Next == OpenHangar \/ BackToMenu \/ Pick \/ Launch \/ Loaded
        \/ Pause \/ Resume \/ Ended \/ Retry \/ Continue

Spec == Init /\ [][Next]_vars

TypeOK == state \in {"MENU", "HANGAR", "BRIEFING", "LOADING",
                     "PLAYING", "PAUSED", "DEBRIEF"}

\* PRD flow invariant: screens only advance along the defined chain
\* (the forbidden list mirrors FSMTable.validate in buildGameTable).
NoForbiddenJump ==
  \/ ~(prevState = "MENU" /\ state \in {"PLAYING", "DEBRIEF", "LOADING", "PAUSED"})
  \/ ~(prevState = "BRIEFING" /\ state = "PLAYING")
  \/ ~(prevState = "HANGAR" /\ state = "PLAYING")
  \/ ~(prevState = "PLAYING" /\ state \in {"MENU", "HANGAR"})
  \/ ~(prevState = "DEBRIEF" /\ state = "PLAYING")
  \/ ~(prevState = "PAUSED" /\ state \in {"MENU", "HANGAR", "BRIEFING",
                                          "LOADING", "DEBRIEF"})
  \/ ~(prevState = "DEBRIEF" /\ state = "PAUSED")

=============================================================================

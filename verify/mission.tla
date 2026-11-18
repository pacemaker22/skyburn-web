(***************************************************************************)
(* Skyburn Phase 4 (Task 4.1) - Mission FSM, model-checked with TLC.       *)
(* Mirrors buildMissionTable() in src/mission/mission.js:                  *)
(*   NOT_STARTED -> STAGE_ACTIVE -> (SUCCESS | FAILED), STAGE_ADVANCE      *)
(*   loops STAGE_ACTIVE while stages remain, terminals accept RESTART.     *)
(*                                                                         *)
(* Liveness model: a stage's objectives either complete (nondeterministic  *)
(* ObjectivesDone) or the stage timer expires (bounded Budget, mirroring   *)
(* the per-stage fail timers in missions.json) -> STAGE_FAILED. Either way *)
(* every ACTIVE stage eventually ends - the PRD "every ACTIVE eventually   *)
(* ends" property. Model scale: 2 stages, budget 2 ticks.                  *)
(*                                                                         *)
(* TLC proves (see mission.cfg):                                           *)
(*   - TypeOK,                                                             *)
(*   - TerminalSticky: SUCCESS/FAILED never switch to each other and       *)
(*     never resume STAGE_ACTIVE except through RESTART -> NOT_STARTED,    *)
(*   - no deadlock,                                                        *)
(*   - ActiveTerminates: STAGE_ACTIVE always eventually reaches SUCCESS    *)
(*     or FAILED (weak fairness).                                          *)
(***************************************************************************)
---- MODULE mission ----
EXTENDS Naturals

NStages == 2
Budget == 2

VARIABLES state, stage, t, prevState
vars == <<state, stage, t, prevState>>

Init == /\ state = "NOT_STARTED"
        /\ stage = 0
        /\ t = 0
        /\ prevState = "NOT_STARTED"

Macro == prevState' = state

Start == /\ state = "NOT_STARTED"
         /\ stage' = 0
         /\ t' = 0
         /\ Macro
         /\ state' = "STAGE_ACTIVE"

TimerTick == /\ state = "STAGE_ACTIVE" /\ t < Budget
             /\ t' = t + 1
             /\ stage' = stage
             /\ Macro
             /\ state' = state

ObjectivesDone == /\ state = "STAGE_ACTIVE" /\ t < Budget
                  /\ stage = NStages - 1
                  /\ Macro
                  /\ state' = "SUCCESS"
                  /\ t' = t /\ stage' = stage

Advance == /\ state = "STAGE_ACTIVE" /\ stage < NStages - 1
           /\ stage' = stage + 1
           /\ t' = 0
           /\ Macro
           /\ state' = "STAGE_ACTIVE"

StageFailed == /\ state = "STAGE_ACTIVE" /\ t >= Budget
               /\ Macro
               /\ state' = "FAILED"
               /\ t' = t /\ stage' = stage

Restart == /\ state \in {"SUCCESS", "FAILED"}
           /\ Macro
           /\ state' = "NOT_STARTED"
           /\ t' = 0 /\ stage' = 0

Next == Start \/ TimerTick \/ ObjectivesDone \/ Advance \/ StageFailed \/ Restart

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK ==
  /\ state \in {"NOT_STARTED", "STAGE_ACTIVE", "SUCCESS", "FAILED"}
  /\ stage \in 0..(NStages - 1)
  /\ t \in 0..Budget

\* Terminal states never switch to each other and never resume a stage
\* directly (only Restart -> NOT_STARTED is allowed).
TerminalSticky ==
  /\ ~(prevState = "SUCCESS" /\ state = "FAILED")
  /\ ~(prevState = "FAILED" /\ state = "SUCCESS")
  /\ ~(prevState \in {"SUCCESS", "FAILED"} /\ state = "STAGE_ACTIVE")

\* Liveness: an active stage always eventually ends (objective completion
\* or the stage fail timer - never a hang).
ActiveTerminates ==
  []( (state = "STAGE_ACTIVE") => <>(state \in {"SUCCESS", "FAILED"}) )

=============================================================================

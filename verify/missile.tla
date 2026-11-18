(***************************************************************************)
(* Skyburn Phase 4 (Task 4.1) - Missile FSM, model-checked with TLC.       *)
(* Mirrors the PRD missile FSM and the executable table in                 *)
(* src/combat/missiles.js one-to-one:                                      *)
(*   SPAWN -> BOOST -> GUIDE -> PROXIMITY -> HIT/MISS/TIMEOUT              *)
(*          -> EXPLODE -> RECYCLE (-> SPAWN on pool reuse),                *)
(* with the PRD invariant "GUIDE cannot go to SPAWN".                      *)
(*                                                                         *)
(* Model scale: time is a bounded counter; motor burns 1 tick, total life  *)
(* is 3 ticks (model scale of BOOST_TIME/LIFE in MISSILE_TUNING). Timer    *)
(* expiry drives MOTOR_DONE / LIFE_OVER exactly like fsm.timeInState does  *)
(* in the real engine; the probabilistic/geometry events (FUSE_IN,         *)
(* CONTACT, DECOYED, OUT_OF_CHASE) are nondeterministic choices, which is  *)
(* the conservative over-approximation for liveness checking.              *)
(*                                                                         *)
(* TLC proves (see missile.cfg):                                           *)
(*   - TypeOK: state is always one of the nine FSM states,                 *)
(*   - SpawnOnlyFromRecycle: SPAWN is only (re)entered from RECYCLE -      *)
(*     in particular GUIDE can never go to SPAWN (PRD invariant),          *)
(*   - no deadlock (every state has an outgoing action),                   *)
(*   - EventuallyExploded: every BOOST/GUIDE/PROXIMITY missile             *)
(*     eventually reaches EXPLODE and then RECYCLE (weak fairness).        *)
(***************************************************************************)
---- MODULE missile ----
EXTENDS Naturals

MotorDoneTime == 1
LifeTime == 3

VARIABLES state, t, prevState
vars == <<state, t, prevState>>

Init == /\ state = "SPAWN"
        /\ t = 0
        /\ prevState = "SPAWN"

\* every action records prevState so the invariant can talk about transitions
Macro(to) == /\ prevState' = state
             /\ state' = to

Flying == {"BOOST", "GUIDE", "PROXIMITY"}

Launch == /\ state = "SPAWN" /\ Macro("BOOST") /\ t' = 0

Fly == /\ state \in Flying
       /\ t < LifeTime
       /\ t' = t + 1
       /\ Macro(state)

MotorDone == /\ state = "BOOST" /\ t >= MotorDoneTime /\ Macro("GUIDE") /\ t' = 0

FuseIn == /\ state = "GUIDE" /\ Macro("PROXIMITY") /\ t' = 0

Contact == /\ state = "PROXIMITY" /\ Macro("HIT") /\ t' = 0

Decoyed == /\ state \in {"GUIDE", "PROXIMITY"} /\ Macro("MISS") /\ t' = 0

OutOfChase == /\ state = "PROXIMITY" /\ Macro("MISS") /\ t' = 0

LifeOver == /\ state \in Flying
            /\ t >= LifeTime
            /\ Macro("TIMEOUT")
            /\ t' = 0

Detonate == /\ state \in {"HIT", "MISS", "TIMEOUT"} /\ Macro("EXPLODE") /\ t' = 0

Done == /\ state = "EXPLODE" /\ Macro("RECYCLE") /\ t' = 0

Freed == /\ state = "RECYCLE" /\ Macro("SPAWN") /\ t' = 0

Next == Launch \/ Fly \/ MotorDone \/ FuseIn \/ Contact \/ Decoyed
        \/ OutOfChase \/ LifeOver \/ Detonate \/ Done \/ Freed

Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

TypeOK == state \in {"SPAWN", "BOOST", "GUIDE", "PROXIMITY",
                     "HIT", "MISS", "TIMEOUT", "EXPLODE", "RECYCLE"}

\* PRD invariant: GUIDE cannot go to SPAWN - SPAWN is only ever the initial
\* state or re-entered from RECYCLE (pool reuse).
SpawnOnlyFromRecycle == (state = "SPAWN") =>
  (prevState = "SPAWN" \/ prevState = "RECYCLE")

\* Liveness: every launched missile always ends up EXPLODEd / RECYCLEd.
EventuallyExploded ==
  []( (state \in Flying) => <>(state \in {"EXPLODE", "RECYCLE"}) )

=============================================================================

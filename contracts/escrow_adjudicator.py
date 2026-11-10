# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
Internet Court x GenLayer — Adjudicated Paywall
==============================================

Escrow-less dispute layer for x402-paid agent services.

Flow
----
1. A seller agent exposes a paid HTTP endpoint (price, spec) and gets paid by a
   buyer agent through x402 (`payment_ref` = settlement tx hash).
2. The seller delivers an artifact. If the buyer thinks the delivery violated
   the published spec, it opens a case here with the spec, the delivery, and
   the payment reference.
3. `adjudicate()` runs inside GenVM consensus: the validator set re-reads the
   same agreement + delivery and must agree on the *verdict* and the *quality
   bucket*. The verdict is written back as reputation, so the next agent that
   wants to buy from this seller can read a consensus-backed score instead of
   trusting a private backend.

Nothing here moves funds: the contract is the neutral judgment layer. A payer
can wire the verdict into a refund rail (or an ERC-7710 revocation controller)
by reading `get_case()` / `get_reputation()`.
"""

import json
from dataclasses import dataclass

from genlayer import *

ERROR_EXPECTED = "[EXPECTED]"
ERROR_EXTERNAL = "[EXTERNAL]"
ERROR_TRANSIENT = "[TRANSIENT]"
ERROR_LLM = "[LLM_ERROR]"

VERDICT_RELEASE = "RELEASE"          # delivery matched the spec -> seller paid out
VERDICT_PARTIAL = "PARTIAL_REFUND"   # delivery partially matched -> split
VERDICT_REFUND = "REFUND"            # delivery violated the spec -> buyer made whole

def _new_case(case_id, buyer, seller, amount_atto, spec, payment_ref, delivery_url, delivery_inline):
    return {
        "case_id": case_id, "buyer": buyer, "seller": seller,
        "amount_atto": str(int(amount_atto)),
        "spec": spec, "payment_ref": payment_ref,
        "delivery_url": delivery_url, "delivery_inline": delivery_inline,
        "status": "OPEN", "verdict": "", "quality_bucket": "", "reasoning": "",
        "adjudicated_at": "",
    }


class AdjudicatedPaywall(gl.Contract):
    owner: Address
    cases: TreeMap[str, str]           # case_id -> JSON payload (node-safe serialization)
    case_order: DynArray[str]
    reputation: TreeMap[str, str]      # agent address -> JSON scoreboard
    verdict_count: u256

    def __init__(self):
        self.owner = gl.message.sender_address
        self.verdict_count = 0

    # ------------------------------------------------------------------ writes

    @gl.public.write
    def open_case(
        self,
        case_id: str,
        seller: str,
        amount_atto: u256,
        spec: str,
        payment_ref: str,
        delivery_url: str,
        delivery_inline: str,
    ) -> None:
        if case_id in self.cases:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} case {case_id} already exists")
        if len(str(spec).strip()) == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} empty spec")
        if len(str(delivery_url).strip()) == 0 and len(str(delivery_inline).strip()) == 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} no delivery evidence")

        self.cases[case_id] = json.dumps(_new_case(
            case_id, str(gl.message.sender_address), str(seller), int(amount_atto),
            spec if isinstance(spec, str) else json.dumps(spec), str(payment_ref), str(delivery_url),
            delivery_inline if isinstance(delivery_inline, str) else json.dumps(delivery_inline),
        ))
        self.case_order.append(case_id)

    @gl.public.write
    def adjudicate(self, case_id: str) -> str:
        if case_id not in self.cases:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} unknown case {case_id}")
        c = json.loads(self.cases[case_id])
        if c["status"] == "ADJUDICATED":
            raise gl.vm.UserError(f"{ERROR_EXPECTED} case {case_id} already adjudicated")

        spec = c["spec"]
        url = c["delivery_url"]
        inline = c["delivery_inline"]

        def judge() -> dict:
            # gather evidence: public URL first, inline copy as fallback
            ev = None
            for source in (url, inline):
                if source is None or len(source.strip()) == 0:
                    continue
                artifact = ""
                try:
                    if source.startswith("http"):
                        res = gl.nondet.web.get(source)
                        if res.status >= 500:
                            raise gl.vm.UserError(f"{ERROR_TRANSIENT} artifact host {res.status}")
                        if res.status >= 400:
                            raise gl.vm.UserError(f"{ERROR_EXTERNAL} artifact host {res.status}")
                        artifact = res.body.decode("utf-8", "ignore")
                    else:
                        artifact = source
                except gl.vm.UserError:
                    raise
                except Exception:
                    # unreachable host -> fall back to the next source
                    continue
                if len(artifact.strip()) > 0:
                    ev = {"artifact": artifact[:6000], "source": source[:120]}
                    break
            if ev is None:
                raise gl.vm.UserError(f"{ERROR_EXTERNAL} no reachable delivery evidence")

            prompt = f"""You are a neutral adjudicator for agent-to-agent commerce.

AGREEMENT (what the seller promised, published before payment):
{spec}

DELIVERED ARTIFACT (what the buyer actually received after paying):
{ev['artifact']}

Decide strictly:
- "matches"  -> the artifact satisfies the promised requirements
- "partial"  -> some promised requirements are satisfied, some are missing or broken
- "violates" -> the artifact misses or breaks the core promise (wrong data, empty, fabricated, off-spec)

Return JSON only:
{{"quality_bucket": "matches|partial|violates",
  "verdict": "RELEASE|PARTIAL_REFUND|REFUND",
  "violations": ["..."],
  "reasoning": "2-3 sentences citing the concrete evidence you compared"}}"""
            raw = gl.nondet.exec_prompt(prompt, response_format="json")
            return _normalize_verdict(raw)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, judge, case_id)
            try:
                validator_out = judge()
            except Exception:
                return False
            leader_out = leaders_res.calldata
            # substantive agreement required: same bucket AND same verdict
            return (
                str(leader_out.get("quality_bucket")) == str(validator_out.get("quality_bucket"))
                and str(leader_out.get("verdict")) == str(validator_out.get("verdict"))
            )

        result = gl.vm.run_nondet_unsafe(judge, validator_fn)

        c["status"] = "ADJUDICATED"
        c["verdict"] = result["verdict"]
        c["quality_bucket"] = result["quality_bucket"]
        c["reasoning"] = result["reasoning"]
        c["adjudicated_at"] = str(result.get("adjudicated_at") or "")
        self.cases[case_id] = json.dumps(c)

        self._update_reputation(c["seller"], result["verdict"], result["quality_bucket"], u256(int(c["amount_atto"])))
        self._update_reputation(c["buyer"], "BUYER_OK", "buyer", u256(0))
        self.verdict_count = self.verdict_count + u256(1)
        return result["verdict"]

    @gl.public.write
    def set_owner(self, new_owner: str) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} only owner")
        self.owner = Address(new_owner)

    # ------------------------------------------------------------------- views

    @gl.public.view
    def get_case(self, case_id: str) -> dict:
        if case_id not in self.cases:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} unknown case {case_id}")
        return json.loads(self.cases[case_id])

    @gl.public.view
    def get_reputation(self, agent: str) -> dict:
        agent = str(agent).lower()  # view args arrive as Address objects
        if agent not in self.reputation:
            rep = self._blank_reputation(agent)
        else:
            rep = json.loads(str(self.reputation[agent]))
        return {
            "agent": rep.get("agent", agent),
            "score": int(rep.get("score", 0)),
            "deals": int(rep.get("deals", 0)),
            "releases": int(rep.get("releases", 0)),
            "partials": int(rep.get("partials", 0)),
            "refunds": int(rep.get("refunds", 0)),
            "unpaid_atto": str(rep.get("unpaid_atto", "0")),
        }

    @gl.public.view
    def verdict_count_view(self) -> int:
        return int(self.verdict_count)

    @gl.public.view
    def list_cases(self) -> list:
        return list(self.case_order)

    # --------------------------------------------------------------- internal

    def _update_reputation(self, agent: str, verdict: str, bucket: str, amount_atto: u256) -> None:
        agent = str(agent).lower()
        if agent in self.reputation:
            rep = json.loads(str(self.reputation[agent]))
        else:
            rep = self._blank_reputation(agent)

        if verdict == VERDICT_RELEASE:
            rep["releases"] += 1
            rep["score"] = min(100, rep["score"] + 10)
        elif verdict == VERDICT_PARTIAL:
            rep["partials"] += 1
            rep["score"] = max(0, rep["score"] - 10)
            rep["unpaid_atto"] = str(int(rep["unpaid_atto"]) + int(amount_atto) // 2)
        elif verdict == VERDICT_REFUND:
            rep["refunds"] += 1
            rep["score"] = max(0, rep["score"] - 25)
            rep["unpaid_atto"] = str(int(rep["unpaid_atto"]) + int(amount_atto))
        elif verdict == "BUYER_OK":
            rep["deals"] += 1
            self.reputation[agent] = json.dumps(rep)
            return

        rep["deals"] += 1
        self.reputation[agent] = json.dumps(rep)


    def _blank_reputation(self, agent: str) -> dict:
        return {"agent": agent, "score": 0, "deals": 0, "releases": 0, "partials": 0, "refunds": 0, "unpaid_atto": "0"}


# --------------------------------------------------------------------- helpers


def _normalize_verdict(raw) -> dict:
    """Defensive parsing: LLMs alias keys, wrap JSON, and mix case."""
    if isinstance(raw, str):
        raw = _parse_json(raw)
    if not isinstance(raw, dict):
        raise gl.vm.UserError(f"{ERROR_LLM} non-dict verdict: {type(raw)}")

    bucket = raw.get("quality_bucket") or raw.get("bucket") or raw.get("quality")
    verdict = raw.get("verdict") or raw.get("decision") or raw.get("outcome")
    if bucket is None and verdict is None:
        raise gl.vm.UserError(f"{ERROR_LLM} missing verdict keys: {list(raw.keys())}")

    bucket = str(bucket).strip().lower()
    if bucket in ("match", "matched", "ok", "pass", "satisfies"):
        bucket = "matches"
    if bucket in ("partial_refund", "partially", "partly"):
        bucket = "partial"
    if bucket in ("violate", "violated", "fail", "failed", "broken", "missing"):
        bucket = "violates"
    if bucket not in ("matches", "partial", "violates"):
        raise gl.vm.UserError(f"{ERROR_LLM} bad quality_bucket: {bucket}")

    verdict = str(verdict).strip().upper().replace(" ", "_")
    if verdict in ("PARTIAL", "PARTIAL_REFUNDING", "SPLIT"):
        verdict = VERDICT_PARTIAL
    if verdict not in (VERDICT_RELEASE, VERDICT_PARTIAL, VERDICT_REFUND):
        # derive it from the bucket so the verdict can never contradict the evidence
        verdict = {"matches": VERDICT_RELEASE, "partial": VERDICT_PARTIAL, "violates": VERDICT_REFUND}[bucket]

    violations = raw.get("violations") or []
    if isinstance(violations, str):
        violations = [violations]
    violations = [str(v)[:200] for v in violations][:6]

    reasoning = str(raw.get("reasoning") or raw.get("analysis") or "")[:900]
    if len(reasoning) == 0:
        raise gl.vm.UserError(f"{ERROR_LLM} empty reasoning")

    out = {
        "quality_bucket": bucket,
        "verdict": verdict,
        "violations": violations,
        "reasoning": reasoning,
    }
    return out


def _parse_json(text: str) -> dict:
    import re

    first = text.find("{")
    last = text.rfind("}")
    if first == -1 or last == -1:
        raise gl.vm.UserError(f"{ERROR_LLM} no JSON object in: {text[:160]}")
    text = text[first:last + 1]
    text = re.sub(r",(?!\s*?[{[\"\w])", "", text)  # trailing commas
    try:
        return json.loads(text)
    except Exception:
        raise gl.vm.UserError(f"{ERROR_LLM} unparsable JSON: {text[:160]}")


def _handle_leader_error(leaders_res, judge_fn, case_id: str) -> bool:
    leader_msg = leaders_res.message if hasattr(leaders_res, "message") else ""
    try:
        judge_fn()
        return False  # leader failed, validator succeeded -> disagree
    except gl.vm.UserError as e:
        validator_msg = e.message if hasattr(e, "message") else str(e)
        if validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL):
            return validator_msg == leader_msg
        if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False

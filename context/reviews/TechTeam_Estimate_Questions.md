# Reply to the development team — estimate and staffing

**Send as email, or paste into the team channel.** Keep whichever fits how you normally work with them.

**Before sending:** confirm whether they have actually seen the architecture reference and the existing Fleet screens. If they have not, that changes the tone of section 1 from "checking" to "here is what exists".

---

## Draft

Subject: Initial release — scoping questions before we agree the plan

Hi [Name],

Thanks for putting the roadmap and staffing model together. Before we get into the numbers I want to make sure we are scoping the same system, because I suspect we may not be — and if so, that is on our side for not writing the scope down clearly enough.

Five questions, in the order that matters.

**1. What does "the initial version" contain?**

Could you send a written scope — even a page. Specifically, does it cover only the software, or does it also cover getting devices onto machines: procurement, SIM activation, installation and commissioning?

I ask because some of this already exists and I do not want you quoting to rebuild it. We have seven fleet dashboard screens built as a working prototype, a written device and protocol specification, and an architecture reference covering the ingestion path, data model and tenancy. I will share all of it. If your plan assumes a greenfield build, the estimate is answering a different question from the one I am asking.

**2. The physical track is not in the plan, and it is what sets the date.**

Nothing in the roadmap mentions hardware. From our side the sequence looks like this, and every step waits on the one before it:

confirm CAN program numbers with Teltonika → order devices and adapters → open the M2M SIM account → book a licensed auto-electrician → install and verify on real machines

Most of that is other people's calendars — a vendor's response time, a distributor's stock, and a machine that is out working and cannot be wired today. It runs for weeks and none of it goes faster with more developers.

Two things I need to know: **who owns this track**, and **when does the program-number enquiry go out?** That enquiry decides which of our machines can produce engine hours at all, which decides which machines the pilot can even use. Until it is answered, any plan is provisional.

I would also like to agree the definition of a completed install now: **engine hours visible on our server**, not "device fitted". A device that reports position but no engine data looks perfectly healthy, and we would not find out for months.

**3. I would like to change what month one proves.**

A POC on display capabilities front-loads the part of this we are least worried about — and it is close to what the existing screens already do. What I would rather buy in month one is an answer to the questions that could invalidate the design:

- Do the devices behave the way the documentation says at the handshake and the acknowledgement?
- Does the CAN adapter actually yield engine hours on the makes and models we own?
- Does the ingestion path acknowledge a record only after it is durably stored — testable by killing the store mid-transmission and confirming the device replays with no gap?
- Does an outage replay reconstruct trips and engine-hour deltas correctly?

That is two devices, one adapter, one machine, one listener and a few days. It costs very little, and every one of those questions is far cheaper to answer in month one than in month four.

**4. On the team shape.**

Rather than debate headcount: **what are the five developers working on, and what are the interfaces between those workstreams?** From where I sit the core is one telemetry contract, one schema, one tenancy model and one ingestion path — which reads like one or two people's work, with a third on the dashboard integration. I would genuinely like to see what I am missing.

Two related questions. What is the DevOps engineer deploying — what infrastructure does the design assume? And on QA: what is the test approach for a four-hour outage replay, and how do you generate device traffic before hardware exists? Those are the defects that will actually hurt us — out-of-order arrival, duplicate delivery, unobserved gaps recorded as idle time, and a record resolving to the wrong customer.

**5. When does the five months start?**

You noted that recruiting experienced talent will be necessary. Does the five months begin at agreement, or at the point the team is assembled and productive? If it is the latter, I would like to see the hiring plan alongside the delivery plan, and to understand who carries the risk if hiring runs long.

And one last one: **what are the three assumptions that, if they turn out wrong, break the five months?**

---

**What I would suggest as next steps**

1. I send you the architecture reference, the device specification and access to the existing screens this week.
2. You come back on questions 1 and 2 — the scope, and who owns the physical track. Those two change the meaning of everything else.
3. We start the program-number enquiry and order two test units **now**, in parallel, without waiting for the plan to be agreed. Nothing about that depends on the design being settled, and it removes weeks from the end date.
4. Short call once you have had a look, with your architect and ours on it.

One thing I would like to hold constant whatever we agree: the record format everything downstream reads stays ours. If the ingestion tier changes later — and it may — that is what keeps it a component swap rather than a rewrite.

Happy to be told I have this wrong on any of it.

Best,
Afsal

---

## Notes — why the draft is written this way

**Scope goes first, deliberately.** Challenging headcount as the opening move invites a defensive re-quote — they lower the number to keep the deal and nothing is actually understood. Establishing what they think they are building either explains the gap or makes it undeniable, and it costs them nothing to answer. Nine people is not a crazy number for a large scope; it is a crazy number for this one.

**Section 1 gives them a way out that costs no face.** "That is on our side for not writing the scope down clearly enough" is not true, exactly, but it converts a confrontation into a correction. You lose nothing and they can revise without climbing down.

**Section 2 is the one that matters most.** Their plan omits the critical path entirely. That is not a padding problem, it is a *this-will-slip-and-nobody-will-see-it-coming* problem, and it is worth being direct about. Note the framing: not "you forgot something" but "here is the sequence as we see it, who owns it?" — which gets you an answer instead of a defence.

**The install definition is planted early on purpose.** It is cheap to agree now and very expensive to introduce later, once installs have been signed off on a different standard. Get it in writing before anyone touches a machine.

**Section 3 asks them to move risk forward, which is the single highest-value change in the whole exchange.** A display POC defers every dangerous question into full-scale development. Framing it as "what I would rather buy" keeps it a client's prerogative rather than a criticism of their judgement.

**Section 4 avoids the headcount fight and asks the question that settles it anyway.** If they can name five genuine workstreams with clean interfaces, the number may be justified and you have learned something. If they cannot, the number came from a team template and both of you now know it — without you having to say so. The outage-replay question is the sharpest single question in the message: it distinguishes a team that has built telemetry from a team that has built web applications.

**Section 5 surfaces the hidden two to three months.** "Recruiting will be necessary" is doing a lot of quiet work in their original message. Sourcing, notice periods and a new team forming realistically sit *in front of* the five months. Ask who carries that risk — the answer tells you what kind of commercial arrangement this actually is.

**The "three assumptions" question is the tell.** Anyone who has stress-tested an estimate can answer it immediately. Anyone who produced it from a template will struggle, and you will hear it.

**Next step 3 is the real ask.** Everything else is conversation; starting the program-number enquiry and ordering two test units this week is the thing that actually moves the date. Do it whether or not the plan is agreed, and whoever ends up building the software.

**The last line about the record format** is small and matters more than it looks. It is the difference between being able to change your mind about the ingestion tier later and being locked into whoever builds it first.

---

## Reading their answers

| Question | Good answer sounds like | Worrying answer sounds like |
|---|---|---|
| Scope | A written list, with hardware and installation explicitly in or explicitly out | "The full platform", or a re-quote with no scope attached |
| Physical track | "We assumed you own it — here is what we need from you and by when" | "We will handle that during development" |
| Program numbers | "We will raise it this week, here is the fleet data we need" | Treated as a detail for later |
| Month one | Engages with the four questions, may propose better ones | Defends the display POC on the grounds that it de-risks integration |
| Five workstreams | Names them with interfaces, and possibly changes the number themselves | Restates the roles rather than the work |
| Outage replay | Talks about generated traffic, replay fixtures, idempotency, clock skew | Talks about test cases and regression suites |
| Five months start | "At team completion — here is the hiring plan" | "At signature", with no hiring plan |
| Three assumptions | Answers in under a minute | Needs to come back to you |

A team that engages seriously with even half of this is worth working with. A team that returns the same numbers with more confidence is telling you what the next twelve months look like.

---

## If you want a shorter version

For a channel message rather than an email, send only this and keep the rest for the call:

> Thanks for the roadmap — before we get into the numbers, three things.
>
> **1.** Can you send a written scope of "the initial version"? Specifically whether it covers only software, or also getting devices onto machines. We already have seven dashboard screens built, a device and protocol spec, and an architecture reference — I will share all of it, and I do not want you quoting to rebuild what exists.
>
> **2.** The plan does not mention the hardware track: CAN program numbers from Teltonika, procurement, SIM activation, the electrician, install verification. That runs for weeks, it is strictly serial, and it is what sets the date. Who owns it, and when does the program-number enquiry go out?
>
> **3.** I would like to swap the month-one display POC for a device POC — two units, one adapter, one machine, one listener. It answers the questions that could invalidate the design, and it costs almost nothing.
>
> Regardless of where we land on the plan, I would like to start the program-number enquiry and order two test units this week. Nothing about that depends on the design being agreed.

# Moderneer Product Context

**Canonical product and executive-messaging context — 2 October 2026**

This document consolidates the current implementation, refreshed Edge/Telos documentation, website strategy and project decisions into one source of truth for product, architecture and public messaging.

## 1. Executive definition

**Moderneer is an evidence-to-judgement platform for enterprise leadership.**

It connects fragmented evidence from existing systems, analyses and links that evidence, makes trust and uncertainty visible, synthesises the choices that require leadership attention, and carries chosen actions into accountable commitments and repeat assessment.

Primary category language:

- **System of Judgement**
- **Operating judgement layer**
- **Evidence-to-judgement platform**

Primary proposition:

**Turn signals into decisions you can defend.**

Moderneer does not replace systems of record, and Telos does not make the executive decision. Systems of record remain authoritative; Moderneer adds analysis, synthesis, trust and follow-through above them.

## 2. The problem

Enterprises are signal-rich but judgement-poor. Relevant evidence is fragmented across systems, teams and narratives. Dashboards show slices rather than a joined position, important claims can lack visible provenance, recommendations are easily confused with decisions, and decisions can leave meetings without durable ownership or reassessment.

Moderneer is designed around continuity from evidence to judgement rather than another reporting surface.

## 3. Canonical operating model

**Frame → Connect → Assess → Trust → Synthesize → Judge → Commit → Learn**

1. **Frame** — establish run context and select executive considerations that define run priorities.
2. **Connect** — configure relevant evidence sources.
3. **Assess** — Edge discovers/ingests, normalises, analyses and produces stack-level and run-level outputs.
4. **Trust** — expose coverage, provenance, confidence, reliability and integrity rather than implying unsupported certainty.
5. **Synthesize** — combine recommendations, decision options, executive considerations, risks and evidence into a Decision Agenda.
6. **Judge** — leadership challenges evidence, compares alternatives and trade-offs, and makes the decision.
7. **Commit** — convert the chosen action into explicit ownership, dates and status.
8. **Learn** — repeat runs and new evidence reassess the position and test the intended outcome.

Canonical rule:

**Priorities focus the assessment. Evidence surfaces the decisions. Leadership makes the judgement.**

### New Run is not a mandatory question-entry flow

The standard public story follows New Run: configure evidence sources and select executive considerations individually or through a preset pack.

A separate Decision Scope component exists and can capture purpose, audience, horizon, scope and questions. It must not be represented publicly as a mandatory New Run question step.

## 4. Product architecture

### Moderneer Edge

**Current documented version: 6.0.1**

Edge is the local-first analysis engine and primary run orchestrator.

Processing model:

`Project → Data Stacks → Activities → Global Activities`

Typical stack pipeline:

`Discovery / ingest → Normalisation → Analysis → Assessment / reporting`

Global activities include merged knowledge-graph generation, cross-data-stack linking, project assessment, executive consideration aggregation, recommendations/Decision Agenda, and summary/documentation/index generation.

Edge supports tracked first runs, continuation, global-activities-only reruns and selective reprocessing. Its run-folder contract includes `manifest.json`, `.edge-metadata.json`, per-stack outputs and global-activity outputs.

Edge is designed around a local-first, controllable-egress posture. Storage is abstracted for local or cloud-backed outputs. LLM-assisted enrichment is configurable rather than the only analysis pathway.

### Moderneer Platform

Platform is the shared backend/service layer. Current responsibilities evidenced by the service structure and Telos integration include:

- API/BFF aggregation;
- authentication and permission-related workflows;
- assessment configuration and pillar metadata;
- scoring / assessment compute services;
- run metadata and governance;
- customer/shared service workflows.

Public architecture must not describe Platform as the main Edge run orchestrator. Edge owns analysis-run orchestration.

Some Platform repository documentation contains older/legacy text. Public claims should follow current service structure and current Telos/Edge integration rather than old roadmap language.

### Telos Studio

**Current documented version: 6.0.1**

Telos is an Electron + React desktop application and the decision/execution control plane for Moderneer runs.

Current product surfaces include Home, Edge run operation, Assessment, multi-data-stack Control Plane, risk/cross-stack intelligence, Recommendations, Decision Agenda, Commitments, run-context AI chat and Access Management.

Telos integrates with Edge for report discovery, assessment execution, incremental operations and decision/run-context APIs. It integrates with Platform for authentication, configuration, run metadata/governance and shared workflows.

### Moderneer Design System

The design-system repository supplies the shared framework-agnostic UI foundation: TypeScript Custom Elements, CSS design tokens, theme behavior and accessibility conventions. It is an implementation dependency, not a separate business product.

## 5. Current evidence/data-stack model

Edge currently models **10 data-stack types**:

1. Source control
2. Jira
3. Confluence
4. CI/CD
5. CloudOpEx
6. Filesystem
7. ServiceNow
8. Salesforce
9. OpenTelemetry
10. External intelligence

Source-control flows include GitHub/GitLab paths. Filesystem handling includes local/document-oriented evidence and connector-oriented paths.

### Maturity caveat

The existence of a stack does not imply identical packaged maturity or evidence depth.

- The current Edge README explicitly notes partial/in-progress OpenTelemetry behavior in places.
- External-intelligence implementation exists, but discovery/search paths have carried mock/synthetic markers and quality warnings in the implementation history. Do not market it as uniformly mature competitive intelligence.
- Cross-functional executive considerations do not prove equal evidence coverage across business functions.

Public wording should therefore say **10 Edge data-stack types** and state that coverage/maturity varies by source.

## 6. Technology & Transformation Intelligence

Technology & Transformation is the deepest packaged application today.

The assessment is represented publicly as:

- **12 assessment pillars**
- **365+ documented evidence checks**
- evidence assembled from applicable Edge data stacks

This is proof of packaged depth, not a claim that every executive domain is equally productised.

Cross-functional examples such as market expansion may explain the judgement model only when clearly labelled illustrative.

## 7. Executive considerations and run priorities

Executive considerations are selected inputs that focus a run. They are not pre-written decisions.

Current lenses cover strategy/value, financial/commercial performance, customers/markets, delivery/operations, governance/controls, data/decision quality, people/accountability, and responsible business/automation.

Telos includes Balanced and executive-role preset packs. Packs are prioritisation conveniences; they do not establish evidence coverage.

## 8. Trust and explainability

Implemented trust semantics include:

- **Confidence** — strength of the conclusion;
- **Reliability** — stability/agreement of signals;
- **Integrity** — traceability, freshness and defensibility;
- evidence strength;
- evidence type semantics such as direct, inferred, mixed, missing or contradictory;
- decision-readiness semantics such as ready to decide, needs validation, needs evidence or not ready;
- evidence-basis summaries, main gaps and confidence rationale.

Confidence, reliability and integrity are represented as **run-specific 1–5 measures** in current Telos types/views.

Public examples must not use arbitrary numbers in a way that looks like a real customer/company score. A safer public treatment is to show the 1–5 scale and explain the dimensions.

Governing principle: **certainty must not outrun the evidence.**

## 9. Recommendations, options and Decision Agenda

Recommendations and decisions are deliberately separate.

Recommendation portfolios include **Fix Now**, **Invest** and **Assure** patterns.

The Decision Agenda is a derived output. Current Edge/Telos implementation synthesises executive decision themes from recommendations, decision options, executive considerations, linked risks and supporting evidence.

A decision case can expose why now, evidence basis/strength, confidence, main gap, readiness, credible alternatives, trade-offs/consequences, cost of inaction, reversibility and the next defensible move.

Telos supports executive judgement. It must never be described as autonomously making the final executive decision.

## 10. Commitments and Outcome Engineering

Telos includes commitment workflows, commitment dates and ownership.

The Outcome Engineering loop is:

**judgement → commitment → measurement intent → repeat evidence → reassessment**

Public wording should say expected benefits, success criteria, target metrics and measurement methods can travel with the commitment and repeat runs provide new evidence.

Avoid implying that Moderneer automatically proves business outcomes the source evidence cannot measure.

## 11. Collaboration, access and contextual query

Current Telos implementation includes role/permission-aware feature gating, Access Management, authenticated session handling, run-context chat, participants and mention handling.

Chat should be described as contextual exploration of the selected run, not as an unconstrained general-purpose assistant.

## 12. Current go-to-market entry point

The current land motion is the **30-day Transformation Baseline** for one critical transformation, modernisation or AI initiative.

Credible public outputs include a current-state baseline, cross-domain posture/risk view where evidence supports it, prioritised evidence-linked recommendations and an initial decision/commitment workflow.

The baseline is an entry point, not the boundary of the platform.

Do not invent customers, quantified ROI, certifications or delivery guarantees.

## 13. Horizontal ambition vs packaged reality

The architecture and consideration model are intentionally extensible across executive functions.

The truthful hierarchy is:

- **Horizontal capability:** evidence-to-judgement operating model and executive consideration framework.
- **Deepest packaged application:** Technology & Transformation Intelligence.
- **Illustrative expansion:** cross-functional decision examples where relevant evidence stacks exist.
- **Direction, not mature current capability:** broad meeting/communication intelligence or uniformly mature competitive intelligence.

## 14. Safe public claims

Safe claims include:

- Moderneer connects and analyses evidence across multiple data stacks.
- Edge is local-first and supports controlled network-dependent actions.
- Edge creates cross-stack evidence/run artifacts.
- Telos operates and visualises runs, recommendations, Decision Agenda, commitments and contextual chat.
- Systems of record remain authoritative.
- The Decision Agenda is synthesized from assessed evidence and related decision artifacts.
- Trust and uncertainty are visible.
- Technology & Transformation is the deepest packaged application.
- Leadership makes the final judgement.

## 15. Claims to avoid

Do not claim:

- Moderneer “starts with the decision”;
- New Run requires a natural-language decision question;
- Telos autonomously makes the executive decision;
- every data-stack type has equal maturity/depth;
- OpenTelemetry is uniformly complete;
- external intelligence is a fully mature competitive-intelligence product;
- meeting/communication intelligence is a mature current packaged capability;
- “any data, any decision”;
- invented customer adoption, ROI, certifications or integrations;
- exact trust/customer scores not taken from a real run and clearly identified.

## 16. Website narrative

### Homepage — 10-minute executive story

Evidence-rich/judgement-poor → System of Judgement → set run priorities → connect relevant evidence → assess → expose trust/uncertainty → derive Decision Agenda → human judgement → commitments → reassessment → Technology & Transformation proof point → 30-day Transformation Baseline.

### Telos page — 30-minute product deep dive

1. Set run priorities
2. Build evidence context
3. Assess and understand
4. Know what to trust
5. Derive Decision Agenda
6. Support executive judgement
7. Commit and govern
8. Ask the run context
9. Learn over time
10. Architecture and control

## 17. Source-of-truth precedence

When documentation conflicts, use:

1. current implementation/code and active data contracts;
2. current Edge and Telos README / ARCHITECTURE / VISION;
3. this context plus current website strategy/content guide;
4. current Platform service structure/integration contracts;
5. older roadmap, legacy README or historical marketing material.

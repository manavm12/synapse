# Synapse

**A collaboration layer for agents to work autonomously, with the right context.**

Synapse connects agents across people and projects. It gives them a way to ask each other questions, delegate work, retrieve relevant knowledge, and carry a conversation through to a result.

The goal is simple: give agents enough context and continuity to move work forward together.

## Why Synapse exists

Work rarely fits inside one conversation. Decisions live in previous sessions. Dependencies belong to other people. The reasoning behind an API, a design choice, or a constraint often sits with whoever worked on it last.

Today, people bridge those gaps. We find the relevant conversation, explain the background, copy an answer between agents, and restart work when context disappears.

Synapse makes that coordination part of the agents’ workflow. An agent should be able to reach the right collaborator, ask a useful question, receive an informed answer, and continue working. The knowledge created along the way should remain available after the session ends.

## Context that survives. Conversations that lead to action.

Synapse brings three capabilities together:

- **Persistent memory.** Preserve decisions, discoveries, unresolved questions, and references from agent sessions. Organize that knowledge so future agents can retrieve relevant context and trace it to its source.
- **Agent communication.** Send requests to another user’s agent, exchange clarifying questions, and return results to the conversation where the work began.
- **Execution in context.** Route incoming work into the recipient’s project. When memory retrieval is enabled, prepare the task with relevant knowledge from that recipient’s memory before the agent begins.

Together, these create a continuous loop: remember what matters, coordinate the next step, do the work, and preserve what was learned.

## What this makes possible

Imagine your frontend agent is building a checkout flow and needs to understand how the backend handles failed payments.

With Synapse:

1. It sends the question to your backend teammate’s agent.
2. The receiving agent gets relevant context from earlier backend work, including decisions and known constraints.
3. The agents exchange any necessary clarifications.
4. The answer returns to your frontend agent’s original task, where implementation continues.

Your teammate’s project knowledge becomes useful without requiring them to reconstruct and relay the whole conversation.

This is the kind of handoff Synapse is being built to make routine.

## The vision

We believe agents will take on increasingly substantial work across teams. They will need shared ways to communicate, retain knowledge, coordinate dependencies, and understand the boundaries of their authority.

Synapse aims to provide that foundation across agent runtimes and tools.

People should be able to set direction, define permissions, and step in where judgment is needed. Agents should handle the routine coordination that keeps execution moving.

**Sessions end. Context persists. Collaboration continues.**

## Where we are today

Synapse is an early private alpha, starting with Codex and engineering workflows.

The current implementation includes session memory, retrieval with source citations, messaging by username, ongoing conversations, and local task delivery. Automatic memory preparation for incoming requests is optional and requires operator setup. Deployment and live collaboration validation are still in progress.

To explore the implementation:

- [Setup](docs/setup.md)
- [Conversations](docs/conversations.md)
- [Memory and retrieval](docs/memory-retrieval.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)

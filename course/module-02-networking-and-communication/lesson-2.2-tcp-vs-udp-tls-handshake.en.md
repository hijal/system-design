# Lesson 2.2 — TCP vs UDP, TLS Handshake Deep Dive

**Module 2 — Networking & Communication**

> **Spaced Repetition (Lesson 1.5):** An SLO is usually kept "stricter" than the SLA — why? What is the benefit of that gap?

**Prerequisite:** Lesson 1.4 (Connection Lifecycle intro), 2.1 (DNS)

**By the end of this lesson you will be able to:**

1. State the core differences between TCP and UDP (reliability, ordering, overhead) and understand when to pick which.
2. Explain the steps inside a TLS handshake (certificate validation, key exchange) in detail.
3. Know why TLS 1.2 and TLS 1.3 differ in round trips, and what "0-RTT" buys you.

**Tier:** 3 — Design Exercise

---

## 0. Where TaskFlow Is Right Now

In Lesson 1.4 we treated the TLS handshake as a black box — we only said "some key exchange happens, it takes one or two round trips". Today we open that box. At the same time, we have been assuming all of TaskFlow's communication runs over **TCP** — today we see why that is not always the right choice, and when **UDP** is the better option.

---

## 1. Theory

### 1.1 TCP vs UDP — the Core Difference

In Lesson 1.4 we saw TCP's 3-way handshake. But TCP is only one member of a larger family — at the **transport layer** there are two main protocols: TCP and UDP. Their core philosophical difference:

**TCP (Transmission Control Protocol)** — its motto is **"guaranteed delivery"**. It promises:

- **Reliability** — if a packet is lost, TCP sends it again (retransmission)
- **Ordering** — packets arrive in exactly the order they were sent (even if they took different paths through the network and arrived out of order, TCP reassembles them correctly)
- **Connection-oriented** — a connection must be established with a handshake (Lesson 1.4)

These guarantees have a cost — extra overhead (the handshake, acknowledgement packets, retransmission logic).

**UDP (User Datagram Protocol)** — its motto is **"send it fast, no guarantees"**:

- **No reliability guarantee** — if a packet is lost, UDP does not resend it (the application must handle that itself, if it cares)
- **No ordering guarantee** — packets can arrive in a different order
- **Connectionless** — no handshake needed; you can start sending data immediately

```
TCP:                                    UDP:
Client                Server            Client                Server
  │──SYN─────────────>│                  │──Data Packet 1───────>│
  │<──SYN-ACK──────────│                  │──Data Packet 2───────>│
  │──ACK─────────────>│                  │──Data Packet 3───────>│
  │──Data + wait ACK──>│                  (no handshake,
  │<──ACK──────────────│                   no "did it arrive?"
  │──Data + wait ACK──>│                   confirmation)
  │<──ACK──────────────│
  (confirmation at each step: slower but reliable)   (fast, but no guarantees)
```

> **Trade-off Table — TCP vs UDP**

| Dimension      | TCP                                          | UDP                                              |
| -------------- | -------------------------------------------- | ------------------------------------------------ |
| Reliability    | Guaranteed delivery                          | No guarantee                                     |
| Ordering       | Guaranteed                                   | Not guaranteed                                   |
| Speed/Overhead | Slower (handshake + acks)                    | Faster (no handshake)                            |
| Connection     | Connection-oriented                          | Connectionless                                   |
| Use case       | Web (HTTP/1.1, HTTP/2), file transfer, email | Video calls, gaming, DNS queries, live streaming |

**Why UDP is chosen in some cases:** think about a video call — if a packet for one video frame is lost, retransmitting it the way TCP would makes no sense, because by then the following frames have already arrived. Waiting for the old frame would only make the call choppier. Here **missing one frame is better than delaying**, which is why video and audio streaming, live gaming, and DNS queries favour UDP.

**An important connection for you — HTTP/3 and QUIC:** In Lesson 1.4 we talked about QUIC and said it was "UDP-based". Now that statement makes full sense — QUIC is built on UDP (not TCP), but adds reliability and ordering inside itself (per stream, rather than per whole connection as TCP does). That is exactly how QUIC avoids TCP's head-of-line blocking while still being reliable.

### 1.2 The TLS Handshake — the Steps Inside

Lesson 1.4 showed the TLS handshake briefly. Now let us go inside — it does three main jobs:

1. **Identifying the server (authentication)** — the client confirms it really is talking to `taskflow.app` and not an imposter
2. **Agreeing on a secret key (key exchange)** — the key that will encrypt all further communication
3. **Agreeing on an encryption algorithm (cipher negotiation)** — which encryption method to use

**In TLS 1.2 (2 round trips):**

```
Client                                          Server
  │──"Hello, here are the ciphers I support"────>│
  │<──"OK, let's use this one + here's my         │
  │    certificate (proof of my identity)"────────│
  │──[validates the certificate] "sending my      │
  │   key exchange data"────────────────────────>│
  │<──"key exchange complete, confirming"─────────│
  │ [from here on, all communication is encrypted]│
```

**In TLS 1.3 (1 round trip — a big improvement):**

TLS 1.3 was standardised in 2018 as RFC 8446, and it drastically simplified the handshake — the client sends its key exchange data in the very first message, guessing at the common cipher options, so the whole handshake completes in a single round trip.

```
Client                                          Server
  │──"Hello + my key exchange guess              │
  │   (assuming a common cipher)"───────────────>│
  │<──"OK + certificate + key exchange            │
  │    confirmed + finished"─────────────────────│
  │──"Finished, starting encrypted data"─────────>│
  │ [handshake done in just one round trip]       │
```

TLS 1.3's 1-RTT handshake saves roughly 50–100 milliseconds per new connection compared with TLS 1.2, depending on network latency. If some TaskFlow users are in a distant region (high RTT), that saving becomes noticeable — especially when many new connections are needed.

**0-RTT — one step further:** if a client has connected to this server before (session resumption), TLS 1.3 can skip even that one round trip — the client uses a "pre-shared key" from the previous session to send encrypted application data with its very first message, and the server can process it immediately. But there is an important security trade-off: 0-RTT data is vulnerable to replay attacks, because it is sent before the handshake completes — an attacker can capture that data and send (replay) it again. For that reason 0-RTT should generally only be used for idempotent operations (like loading a cached page), and is kept off for sensitive transactions like payments or logins. (The term idempotency arrives formally in Module 7.4; for now, just hold on to this — "doing the same thing twice gives the same result".)

### 1.3 The State of TLS Today (2026)

Since this is version-dependent information, here is the current standard as of 2026 — TLS 1.0 and 1.1 should be fully disabled (they have known vulnerabilities, and every major compliance standard now forbids them), while TLS 1.2 is still acceptable — it remains PCI DSS compliant, is NIST's minimum approved version, and every major browser still supports it. The industry best practice, though, is to keep both TLS 1.2 and TLS 1.3 enabled (with TLS 1.3 as the preferred option), because TLS 1.3 is both faster (the handshake drops from two round trips to one) and more secure.

**A practical takeaway:** if you configure TaskFlow's TLS through Nginx or Cloudflare, a setting like `ssl_protocols TLSv1.2 TLSv1.3;` is the current (2026) standard practice. TLS 1.0 and 1.1 should never be left enabled.

---

## 2. Interview Angle

A common interview question on TCP vs UDP — "you're building a real-time chat feature (like TaskFlow's), which protocol would you use?" A good answer depends on the reasoning: losing a chat message is not acceptable (a lost message breaks the meaning of the conversation), so you need a TCP-based solution (WebSocket, which runs over TCP), not UDP — unlike a video call, where missing one frame is acceptable.

A frequent follow-up on the TLS handshake: "how would you reduce connection latency on HTTPS?" — a good answer mentions all three: upgrading to TLS 1.3, enabling session resumption / 0-RTT (carefully, for idempotent operations only), and reusing connections with keep-alive (Lesson 1.4).

---

## 3. Key Takeaway

- TCP = reliable and ordered but slower (handshake + ack overhead); UDP = fast but with no guarantees
- Video/audio streaming, gaming, and DNS queries favour UDP, because packet loss is preferable to delay
- QUIC (the basis of HTTP/3) is built on UDP but adds per-stream reliability of its own
- The TLS handshake's jobs: authenticate the server, agree a secret key, settle on a cipher
- TLS 1.2 takes two round trips; TLS 1.3 takes one (saving ~50–100ms)
- 0-RTT session resumption removes handshake latency entirely, but carries replay-attack risk, so it should be used only for idempotent operations
- Current best practice in 2026: TLS 1.0/1.1 disabled, both TLS 1.2 and 1.3 supported, TLS 1.3 preferred

---

## 4. New Terms (Glossary)

| Term                                    | Meaning                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| **TCP (Transmission Control Protocol)** | A reliable, ordered, connection-oriented transport protocol                                |
| **UDP (User Datagram Protocol)**        | A fast but unreliable, connectionless transport protocol                                   |
| **Cipher Suite**                        | A set of encryption algorithms negotiated during the TLS handshake                         |
| **0-RTT (Zero Round Trip Time)**        | A TLS 1.3 feature letting a returning client send encrypted data with no round trip at all |
| **Replay Attack**                       | An attack that re-sends previously captured data packets to confuse a system               |

---

## 5. Reflection Questions

1. If you built a "live cursor" feature in TaskFlow (like Google Docs, showing which task a teammate is working on right now) — would you choose a TCP- or UDP-based solution, and why?
2. Explain in your own words why 0-RTT is safe only for "idempotent" operations, and not for payments or logins.

<details>
<summary><strong>Answer Key</strong></summary>

**Question 1:** This is an interesting borderline case — cursor position data changes constantly and knowing an old position has little value (if one cursor update is missed, the next one will report the correct position anyway). So it fits UDP's philosophy well (packet loss acceptable, low latency is the priority). In practice, most web applications still implement this with WebSocket (TCP-based), because raw UDP access is not readily available in browsers and TCP's overhead is not a problem at this small scale. But conceptually, if the question is about raw protocol choice, UDP's logic applies here.

**Question 2:** An idempotent operation is one where running it multiple times gives the same result (for example, "load this page" — loading it twice does no harm). But a payment ("send ₹500") or a login attempt is not idempotent — if an attacker captures the 0-RTT data and replays it, the payment could go through twice, or the login attempt could be counted twice (which might confuse rate-limiting or security logic). So using 0-RTT for non-idempotent, sensitive operations is dangerous — those need the assurance of a full handshake.

</details>

---

## 6. Practical Exercise

**Tier 3 — Design Exercise**

> **Scenario:** You are considering two new features for TaskFlow:
>
> **Feature A:** "Live Notification Badge" — when someone assigns you a task, a small badge count updates immediately, without a page reload
>
> **Feature B:** "Bulk Task Import" — a user uploads a CSV file containing 1000 tasks, and the system inserts them all into the database
>
> For each one, say:
>
> 1. Is a TCP- or UDP-based approach the sensible one, and why? (Reason using the trade-off table from this lesson.)
> 2. Would TLS 0-RTT be safe for this feature — judge it on the idempotency question.

---

## 7. Progress Ledger

```
=== PROGRESS LEDGER ===
Completed: Module 1 (1.1–1.6) + Exit Challenge, 2.1
Current: 2.2 — TCP vs UDP, TLS Handshake Deep Dive
TaskFlow state: single Express server + 1 Postgres, ~100 users
Terms learned (Module 1): System Design, Scale, Trade-off, Functional/Non-functional
Requirement, Scope, Estimation, HLD, Deep Dive, Black Box, DAU, QPS, Peak QPS,
TCP 3-Way Handshake, TLS Handshake (intro), RTT, Keep-Alive, Head-of-Line Blocking,
Multiplexing, QUIC, Latency, Throughput, Availability, Reliability, SLA, SLO,
Error Budget, Vertical/Horizontal Scaling, SPOF, Stateful/Stateless
Terms learned (Module 2 so far): DNS, Recursive/Iterative Query, TTL, Authoritative
Name Server, DoH/DoT, TCP vs UDP, Cipher Suite, 0-RTT, Replay Attack
Weak spots: covering every sub-part of a multi-part question; using terminology
precisely; a tendency to conflate one core term with a different concept (e.g. DNS TTL
vs data-retention TTL, which happened in the 2.1 exercise) — when learning a new term,
pin down exactly what it controls
Next: 2.3 — REST vs GraphQL vs gRPC
=======================
```

---

## 8. Next Lesson

Send the exercise over. When you are ready, write `next` — we move to Lesson 2.3: REST vs GraphQL vs gRPC, the trade-offs between these three API design approaches — a topic that connects directly to your Express API experience.

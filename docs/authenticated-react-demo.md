# Authenticated React recovery contract

This document defines the security and lifecycle boundaries demonstrated by `apps/web`. The demo
composes the framework-neutral client, React hooks, OIDC authentication, and the authenticated API;
it does not move authentication into the reusable upload packages.

## Trust boundaries

The browser is an OAuth public client. It uses Authorization Code with PKCE and never embeds a
client secret. The identity provider authenticates the user and issues the access token. The API,
not the browser, validates signature, issuer, audience, time claims, and subject.

Every upload request obtains its bearer token from a stable getter at request time. A client
instance therefore does not capture the token that happened to exist when React rendered it. If
the OIDC session expires or is unloaded, new upload requests fail locally with an authentication
error instead of sending an empty credential.

The upload endpoint must be a same-origin path. Local development uses a Vite proxy, and production
should expose the web app and upload path behind the same trusted origin. This design does not
attempt to make a bearer token safe in the presence of arbitrary script execution; normal content
security policy, dependency review, and XSS defenses still apply.

## Persistence boundary

The OIDC adapter stores its transient protocol and user state in `sessionStorage`. The upload
checkpoint store is separate and receives neither access tokens nor file contents.

Checkpoint database names are derived from the verified OIDC `sub` claim:

```text
resumable-upload-kit:<encoded-subject>
```

This prevents one subject using the same browser profile from seeing another subject's recovery
list through the application. Server-side owner checks remain authoritative. Client-side database
separation is a privacy boundary for the interface, not an authorization control.

## React lifecycle

Session restoration and callback completion are deduplicated across React StrictMode's development
effect replay. OIDC loaded, unloaded, and token-expired events update the authentication context.
Changing the authenticated subject creates a new upload client session and closes the old
IndexedDB connection.

Upload work only starts after an explicit user action. Rendering, mounting, unmounting, and effect
replay do not create, resume, or cancel uploads. The underlying hooks ignore stale results from
overlapping operations and use external-store subscriptions for task state.

## Recovery behavior

| Situation                                        | Demo behavior                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------- |
| Page reload during an incomplete upload          | Lists the saved checkpoint for the current subject                              |
| Original file is not selected again              | Keeps metadata visible and performs no file access                              |
| Reselected file fingerprint differs              | Rejects resume and explains the source mismatch                                 |
| Server offset differs after an ambiguous request | Reconciles with the server-authoritative offset                                 |
| Access token changes                             | Uses the latest token on the next request                                       |
| OIDC session expires                             | Stops authenticated requests and returns to the sign-in boundary                |
| Remote upload is gone or expired                 | Surfaces the typed client error and allows stale-entry removal                  |
| User cancels an upload                           | Deletes remotely first and removes the local checkpoint only after confirmation |

The demo does not claim that the browser can resume without the original file, that a token renewal
will succeed for every provider, or that a network request executes exactly once. Its guarantee is
that only server-confirmed progress is treated as durable and ambiguous results are reconciled
before more bytes are sent.

## Deployment checklist

- register the exact callback and post-logout URLs at the identity provider
- enable Authorization Code with PKCE for a public SPA client
- configure the API audience consistently in the provider and `apps/api`
- terminate HTTPS at the application origin
- route the configured same-origin upload path to the API
- apply a restrictive content security policy and avoid untrusted scripts
- test token expiry, logout, browser reload, source mismatch, and API restart behavior

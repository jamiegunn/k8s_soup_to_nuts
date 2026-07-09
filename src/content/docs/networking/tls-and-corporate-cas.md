---
title: TLS and Corporate CAs
description: Serving certs and trust stores from the app-team seat — cert-manager against the platform's issuer, corporate CA bundles in Java and .NET containers, and the x509 error zoo.
keywords:
  - x509 certificate signed by unknown authority
  - PKIX path building failed
  - unable to get local issuer certificate
  - certificate not trusted
  - corporate root CA bundle
  - cert-manager Certificate not Ready
  - Java truststore cacerts keytool
  - SSL_CERT_FILE NODE_EXTRA_CA_CERTS
  - TLS handshake failure
  - openssl s_client SNI
  - expired certificate after renewal
  - mTLS client certificate
sidebar:
  order: 15
---

Every TLS problem you will hit on a corporate cluster is one of exactly two problems, and people conflate them constantly:

- **Serving**: the certificate *you present* to clients. Wrong name, expired, wrong chain → *their* handshake fails against *you*.
- **Trust**: the CA bundle *you believe* when making outbound calls. Corporate proxy re-signs everything, internal services use the corporate CA → *your* handshake fails against *them* with `unknown authority`.

Fixing a trust problem with a new serving cert (or vice versa) is the single most common wasted afternoon in this space. Keep the split in your head; this page is organized around it.

## The corporate TLS map

In the standard corporate topology — F5/NetScaler VIP → MetalLB → ingress-nginx → pods (see [The Front Door](/architectures/front-door/)) — TLS termination can happen at three points, and the cert at each point has a different owner:

| Termination point | Who owns the cert | When it's used |
|---|---|---|
| F5/NetScaler appliance | Network/LB team | Org standard for internet-facing VIPs; often re-encrypts to the ingress |
| ingress-nginx | **You** (Ingress + Secret, usually via cert-manager) | The default for HTTP(S) apps — terminate here |
| The pod itself | **You** (mounted Secret, app config) | Passthrough, mTLS-to-pod, non-HTTP protocols |

The standing recommendations from elsewhere on this site apply directly:

- **HTTP: terminate at the ingress.** The controller handles SNI, renewals flow through Secrets, and you get L7 routing and logging. This is the [front-door architecture](/architectures/front-door/) default.
- **Stateful/non-HTTP protocols (AMQP, MQ, database wire protocols): passthrough.** Terminating a binary protocol at an HTTP ingress mangles it; use SSL passthrough or plain TCP exposure and terminate in the pod — details in [TCP Ingress](/networking/tcp-ingress/).
- If the appliance terminates and re-encrypts, there are **two** certs in play (appliance cert facing clients, ingress cert facing the appliance) and they can fail independently. When "the cert is wrong," first establish *which* cert — the [debugging kit](#the-debugging-kit) below tells them apart.

[MetalLB](/networking/external-load-balancing/) is L4 and never touches TLS — it hands packets to the ingress unopened. If someone blames MetalLB for a cert error, they're one layer off.

:::note
MetalLB and the appliance are invisible to TLS but not to *names*. The cert must match the hostname clients type — which in this topology is the corporate VIP name, not anything Kubernetes-generated. That's a [DNS integration](/routing/dns-integration/) question as much as a TLS one.
:::

## Serving: getting a certificate as an app team

On a platform-managed cluster you don't install cert-manager and you don't create issuers. The platform runs [cert-manager](/controllers/cert-manager/) with one or more **ClusterIssuers** wired to the corporate PKI — internal ACME, Vault, or a CA-key issuer. If the `Certificate → CertificateRequest → Order → Challenge` object model below is new to you, that page walks it end to end from the consumer's seat. You find out what exists and use it:

```bash
kubectl get clusterissuer
```

```console
NAME              READY   AGE
corp-acme         True    412d
corp-vault-ica2   True    280d
```

Which one you're *supposed* to use is a platform policy question, not a technical one — [ask](/operations/working-with-platform-team/) rather than guessing, because the wrong issuer produces a cert that browsers on corporate laptops don't trust.

### The Certificate resource, annotated

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: payments-api-tls
  namespace: payments
spec:
  # cert-manager writes the signed cert + key here; the Ingress references it
  secretName: payments-api-tls
  issuerRef:
    name: corp-acme            # the platform's ClusterIssuer — not yours to invent
    kind: ClusterIssuer
  commonName: payments.corp.example.com
  dnsNames:                     # SANs — the names clients actually USE
    - payments.corp.example.com # the corporate VIP name (what's in DNS)
    - payments-api.corp.example.com
  duration: 2160h               # 90d; many corporate CAs cap this — don't fight it
  renewBefore: 720h             # renew with 30d left
  privateKey:
    algorithm: RSA
    size: 2048                  # some corporate middleware still chokes on EC keys
```

Apply it, and within a minute or two:

```bash
kubectl get certificate -n payments
```

```console
NAME               READY   SECRET             AGE
payments-api-tls   True    payments-api-tls   2m
```

The Secret is a normal `kubernetes.io/tls` Secret ([Secrets](/workloads/secrets/) covers the type), and your Ingress consumes it exactly as described in [Ingress and Routing](/networking/ingress-and-routing/):

```yaml
spec:
  tls:
    - hosts: [payments.corp.example.com]
      secretName: payments-api-tls
```

### The ingress-shim shortcut

For the common case — one cert, terminating at [ingress-nginx](/networking/ingress-nginx/) — skip the Certificate CR entirely and annotate the Ingress:

```yaml
metadata:
  annotations:
    cert-manager.io/cluster-issuer: corp-acme
```

cert-manager's ingress-shim generates the Certificate for you, with `dnsNames` taken from the Ingress `tls.hosts`. It's less typing and it keeps hosts and SANs in sync by construction. Use the explicit CR when you need extra SANs, non-default durations, key algorithms, or a cert for something that isn't an Ingress.

### SAN discipline

The cert must cover **every name a client will put in the URL bar or connection string** — nothing more matters. In this topology that means the corporate VIP name(s) registered in enterprise DNS, not the Service name, not the pod, not some `*.cluster.local` name nobody outside the cluster resolves. If the same app answers on `payments.corp.example.com` externally and `payments.internal.example.com` from the datacenter, both go in `dnsNames`. Getting names registered and pointed at the VIP is the [DNS integration](/routing/dns-integration/) workflow; the cert just has to agree with it.

### Renewal mechanics — and the pod-mount trap

cert-manager renews automatically at `renewBefore` and **updates the Secret in place**. Same Secret name, new contents. Nothing about your Ingress changes.

- **Terminating at ingress-nginx:** the controller watches Secrets and hot-loads the new cert. You do nothing. This is a major reason terminate-at-ingress is the recommendation.
- **Terminating in the pod:** the mounted Secret file updates on disk (eventually — kubelet sync, up to ~a minute), but **your process almost certainly loaded the cert once at startup**. Java keystores and Kestrel cert config don't re-read files. You need a reload story — file-watch in the app, a sidecar that signals it, or a scheduled rolling restart shorter than `renewBefore`. The mount-propagation details and the `subPath`-never-updates trap are in [Config Files and Volumes](/workloads/config-files-and-volumes/).

:::caution
The classic outage: pod-terminated TLS works for 60 days, then clients start failing with expired-cert errors *even though the Secret contains a valid renewed cert*. The file on disk is fine; the process is still serving the cert it loaded at boot. Verify your reload path **before** the first renewal window, not during it.
:::

### When the Certificate won't go Ready

cert-manager issuance is a chain of resources, each created by the previous one. Walk it in order — the failure is always at the first link that isn't progressing:

```text
Certificate → CertificateRequest → Order → Challenge   (ACME issuers)
Certificate → CertificateRequest                        (Vault/CA issuers)
```

```bash
kubectl describe certificate payments-api-tls -n payments   # start: READY False, why?
kubectl get certificaterequest -n payments
kubectl get order,challenge -n payments                     # ACME only
kubectl describe challenge -n payments
```

The classic stuck state, verbatim:

```console
NAME                                      STATE     DOMAIN                      AGE
challenge.acme.cert-manager.io/payments-api-tls-1-2749301-0   pending   payments.corp.example.com   14m

Reason: Waiting for HTTP-01 challenge propagation: failed to perform self check
GET request 'http://payments.corp.example.com/.well-known/acme-challenge/xK9...':
dial tcp 10.20.30.40:80: i/o timeout
```

That's the **solver-blocked classic**: the ACME server (or cert-manager's own self-check) must reach your hostname on port 80/DNS, and something in the corporate path — appliance rules, a firewall, DNS not yet pointing at the VIP — blocks it. Decode: HTTP-01 needs the name to route to the ingress *now*; DNS-01 needs cert-manager to have credentials for corporate DNS. Neither is fixable from your namespace — this is a [platform ticket](/operations/working-with-platform-team/) with the Challenge output pasted in. Other frequent describe-output culprits: `issuerRef` name typo'd (CertificateRequest never appears), quota/policy denial from Vault (CertificateRequest `Denied`), and a `duration` longer than the CA allows.

## Trust: the corporate-CA problem

Now the other direction. Your pod calls `https://vault.corp.example.com` or even `https://api.stripe.com` — and in a corporate network the latter often traverses a TLS-inspecting proxy that re-signs traffic with the corporate CA. Your base image's CA bundle (Mozilla's list) has never heard of `Example Corp Root CA 2`, and the runtime refuses the handshake. The same words, per stack — worth memorizing because they all mean *identically* the same thing (full catalog in the [Error Index](/troubleshooting/error-index/)):

```text
Java:   javax.net.ssl.SSLHandshakeException: PKIX path building failed:
        sun.security.provider.certpath.SunCertPathBuilderException:
        unable to find valid certification path to requested target
.NET:   System.Security.Authentication.AuthenticationException:
        The remote certificate is invalid according to the validation procedure:
        RemoteCertificateChainErrors — UntrustedRoot
Go:     x509: certificate signed by unknown authority
curl:   curl: (60) SSL certificate problem: unable to get local issuer certificate
Python: ssl.SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED] unable to get local issuer certificate
```

The diagnosis is always the same: **the corporate root CA is not in the trust store this particular runtime consults.** "This particular runtime" matters — Java does not read the OS bundle by default, so fixing `/etc/ssl/certs` fixes curl and .NET but not the JVM in the same container.

### The fix hierarchy

**(a) The golden base image — the org answer.** The platform or a build team bakes corporate roots into blessed base images: `update-ca-certificates` (Debian) / `update-ca-trust` (RHEL) for the OS bundle, plus the roots imported into the JVM `cacerts`. If your org has these, use them and this whole section becomes someone else's Dockerfile. This is exactly the kind of centralization [supply-chain security](/operations/supply-chain-security/) argues for — one reviewed place where trust is defined, instead of forty snowflake Dockerfiles.

**(b) Mount a CA bundle and point the runtime at it.** When you can't change the image, mount the bundle at runtime. The platform typically publishes the corporate roots as a ConfigMap (often via trust-manager, below):

```yaml
volumes:
  - name: corp-ca
    configMap:
      name: corp-ca-bundle       # key: ca.crt — the PEM bundle
containers:
  - name: app
    volumeMounts:
      - name: corp-ca
        mountPath: /etc/corp-ca
        readOnly: true
```

Then per stack:

**Java.** Three honest options, in order of preference:

1. *Import into `cacerts` at image build.* Best behavior — corporate roots are **added** to the public roots, so both internal and internet endpoints work. Requires owning the Dockerfile.
2. *`-Djavax.net.ssl.trustStore=/path/corp.p12`* — **replaces** the default trust store. Now internet CAs are gone and calls to public endpoints start failing instead. Only correct when the app talks exclusively to corporate endpoints. This is the trap option; people reach for it because it needs no image change, then file a bug that Stripe stopped working.
3. *Init-container keytool import* — no image change, additive trust. Copy the default `cacerts`, import the corporate roots, point the JVM at the merged store:

```yaml
initContainers:
  - name: build-truststore
    image: eclipse-temurin:21-jre
    command: ["/bin/sh", "-c"]
    args:
      - |
        cp $JAVA_HOME/lib/security/cacerts /work/cacerts
        csplit -z -f /work/ca- /etc/corp-ca/ca.crt '/BEGIN CERTIFICATE/' '{*}'
        for c in /work/ca-*; do
          keytool -importcert -noprompt -keystore /work/cacerts \
            -storepass changeit -alias "corp-$(basename $c)" -file "$c"
        done
    volumeMounts:
      - { name: corp-ca, mountPath: /etc/corp-ca, readOnly: true }
      - { name: truststore, mountPath: /work }
containers:
  - name: app
    env:
      - name: JAVA_TOOL_OPTIONS
        value: >-
          -Djavax.net.ssl.trustStore=/work/cacerts
          -Djavax.net.ssl.trustStorePassword=changeit
    volumeMounts:
      - { name: truststore, mountPath: /work, readOnly: true }
volumes:
  - name: corp-ca
    configMap: { name: corp-ca-bundle }
  - name: truststore
    emptyDir: {}
```

The `csplit` handles a bundle with multiple roots — `keytool -importcert` imports only the first PEM block in a file, silently. `JAVA_TOOL_OPTIONS` is the delivery mechanism because it reaches the JVM without touching the image's entrypoint — the whole pattern, including its interaction with other JVM flags, is in [JVM in Containers](/java/jvm-in-containers/); the init-container/emptyDir handoff is [Init and Sidecar Containers](/workloads/init-and-sidecar-containers/) bread and butter. Format note: modern JDKs read both JKS and PKCS12 (`cacerts` is PKCS12 since JDK 9 but keeps compatibility); if you generate a fresh store, make it PKCS12 (`-storetype PKCS12`) — JKS is legacy and some security scanners flag it.

**.NET.** On Linux, .NET validates against the OpenSSL trust store, so the OS-level fix works: in the image, drop the PEM into `/usr/local/share/ca-certificates/corp.crt` and run `update-ca-certificates`. Without an image change, OpenSSL's environment overrides work since .NET respects them:

```yaml
env:
  - name: SSL_CERT_FILE      # a single PEM bundle file
    value: /etc/corp-ca/ca.crt
  # or SSL_CERT_DIR for a hashed directory of certs
```

Caveat: like Java option 2, `SSL_CERT_FILE` **replaces** the default store — mount a bundle that includes the public roots too, or use the image-level `update-ca-certificates` pattern which is additive. Kestrel/HttpClient specifics live in [ASP.NET Core on K8s](/dotnet/aspnetcore-on-k8s/).

**Everything else.** `SSL_CERT_FILE`/`SSL_CERT_DIR` cover most OpenSSL-linked runtimes (curl, Ruby, PHP). Go reads the OS bundle and also honors `SSL_CERT_FILE`. Python's `requests` bundles its own certs and wants `REQUESTS_CA_BUNDLE=/etc/corp-ca/ca.crt`. Node wants `NODE_EXTRA_CA_CERTS` — which is *additive*, the API everyone else should have shipped.

**(c) trust-manager — cluster-native distribution.** [trust-manager](https://cert-manager.io/docs/) (a cert-manager subproject) exists precisely to solve "how does the corporate bundle get into every namespace and stay current." The platform defines a `Bundle` CR; trust-manager renders it into a ConfigMap **in every namespace** and keeps it synced when roots rotate:

```bash
kubectl get configmap corp-ca-bundle -n payments -o jsonpath='{.data.ca\.crt}' | head -3
```

From your seat you don't manage the Bundle — you *consume* the ConfigMap it produces, exactly as in the mounts above, and root rotation stops being your problem. If the ConfigMap doesn't exist in your namespace, that's a one-line platform question.

**(d) What never to do.**

:::danger
Do not disable verification. `curl -k`, `InsecureSkipVerify: true`, `ServerCertificateCustomValidationCallback = ... => true`, Java's copy-pasted `TrustAllX509TrustManager`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`. Every one of these "fixes" the error by turning off the only thing TLS actually provides — you'll happily handshake with anything that answers, including the attacker the corporate proxy exists to catch. It's the cargo-cult fix because it always works and never fails a test. It also never leaves the codebase: grep for these strings in any repo older than two years and you'll find one marked `// TO-DO: temporary`. The correct fix is always "put the right CA in the right trust store," and it takes maybe an hour longer.
:::

## mTLS, honestly

Sometimes the *server* demands a certificate from *you* — a partner API, the F5 enforcing client-cert auth, a corporate service mesh boundary. Two cases:

**The mesh already does it.** If your cluster runs Istio/Linkerd with mTLS enabled, pod-to-pod mTLS is the sidecar's job — your app speaks plaintext to localhost and should **not** layer its own client certs on top. Check before building anything.

**Your app must present a client cert.** Get a client certificate from cert-manager the same way as a serving cert (the platform issuer may require a `usages: [client auth]` entry), mount the Secret, and wire it per stack:

```yaml
volumeMounts:
  - name: client-cert
    mountPath: /etc/client-cert   # tls.crt, tls.key from the Secret
    readOnly: true
```

- **Java:** client certs come from the **keystore** (not the truststore — the eternally confused pair): package `tls.crt`+`tls.key` into a PKCS12 (an init container running `openssl pkcs12 -export` mirrors the keytool pattern above) and set `-Djavax.net.ssl.keyStore=/work/client.p12 -Djavax.net.ssl.keyStoreType=PKCS12`, or configure it on the specific HTTP client, which is cleaner than JVM-global.
- **.NET:** `X509Certificate2.CreateFromPemFile("/etc/client-cert/tls.crt", "/etc/client-cert/tls.key")` into `HttpClientHandler.ClientCertificates`.

Renewal bites twice as hard here — the *remote* side rejects your expired client cert, and their error message will be useless. Same reload rules as pod-terminated serving certs.

## The debugging kit

The tool is [`openssl s_client`](https://docs.openssl.org/master/man1/openssl-s_client/) — run it from a debug container *inside the cluster* so you see what the app sees:

```bash
kubectl run tlsdebug --rm -it --image=alpine/openssl --restart=Never -- \
  s_client -connect payments.corp.example.com:443 \
  -servername payments.corp.example.com -showcerts </dev/null
```

`-servername` is not optional: it sets SNI, and both the F5 and ingress-nginx pick the cert by SNI. Without it you get the default/fallback cert and debug a phantom. Read three things in the output:

```console
Certificate chain
 0 s:CN = payments.corp.example.com          ← leaf: is this YOUR cert?
   i:CN = Example Corp Issuing CA 2          ← issuer: which CA actually signed it
 1 s:CN = Example Corp Issuing CA 2          ← intermediate present? missing = chain error
   i:CN = Example Corp Root CA
...
Verify return code: 0 (ok)                    ← 19/20/21 = trust problem, 10 = expired
```

Then check the SANs on the leaf:

```bash
openssl s_client -connect payments.corp.example.com:443 \
  -servername payments.corp.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -A1 "Subject Alternative Name"
```

**Run the same command from your Mac and compare.** If the leaf differs — different issuer, different SANs — you've found a split-horizon setup: outside the corporate network you hit the appliance's public cert (or the TLS-inspecting proxy's re-signed one), inside you hit the ingress cert directly. Half of "works on my machine but not in the pod" (and all of the reverse) is this. It also tells you *which* of the two certs in an appliance-re-encrypt topology is the broken one.

The expiry one-liner, worth an alias:

```bash
openssl s_client -connect payments.corp.example.com:443 \
  -servername payments.corp.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate
# notAfter=Sep 28 09:14:02 2026 GMT
```

And the cert-manager fleet view:

```bash
kubectl get certificate -A -o wide
```

```console
NAMESPACE   NAME               READY   SECRET             ISSUER      STATUS                                          AGE
payments    payments-api-tls   True    payments-api-tls   corp-acme   Certificate is up to date and has not expired   88d
billing     billing-tls        False   billing-tls        corp-acme   Issuing certificate as Secret does not exist    14m
```

`READY True` plus a sane STATUS is healthy; `False` sends you to the [chain walk](#when-the-certificate-wont-go-ready) above.

## The request templates

Two tickets you'll file repeatedly — [both to the platform team](/operations/working-with-platform-team/); complete ones get turned around in hours instead of days:

**Certificate / issuer request:**

```text
Namespace:      payments
Names (SANs):   payments.corp.example.com, payments-api.corp.example.com
                (both registered in corporate DNS → VIP 10.20.30.40)
Issuer:         whichever ClusterIssuer is standard for internal HTTPS —
                confirm corp-acme is correct for browser-facing internal apps
Duration:       your default (we handle renewal reload; terminating at ingress)
Key type:       RSA 2048 unless you have an EC standard
Usage:          server auth, terminating at ingress-nginx
```

**CA bundle request:**

```text
Namespace:      payments
Need:           corporate root + issuing CA bundle as a ConfigMap for outbound
                TLS to vault.corp.example.com and proxy-inspected internet calls
Ask:            is there a trust-manager Bundle already syncing a ConfigMap
                to all namespaces? If so: name + key. If not: PEM bundle incl.
                Example Corp Root CA + intermediates, and who owns rotation?
```

## Checklist

Before calling TLS done for a service:

- [ ] **Names covered.** Every hostname clients use — VIP names, per-environment names — appears in the cert's SANs. Verified with `openssl x509 -noout -text`, not assumed.
- [ ] **Termination point deliberate.** HTTP at the ingress; stateful protocols passthrough per [TCP Ingress](/networking/tcp-ingress/). You know whether the appliance re-encrypts and which cert lives where.
- [ ] **Trust distributed.** Outbound calls to corporate/inspected endpoints verified from *inside a pod*, not just from a laptop. Java's truststore handled explicitly — the OS bundle doesn't cover the JVM.
- [ ] **Renewal reload verified.** Ingress-terminated: nothing to do. Pod-terminated or client certs: you've *tested* that the app picks up a rotated Secret, before the first real renewal.
- [ ] **Certificate READY and monitored.** `kubectl get certificate -o wide` is green; someone alerts on `Ready=False` older than an hour.
- [ ] **No verify-skips in the repo.** `git grep -iE 'insecureskipverify|trustall|verify=False|rejectUnauthorized|curl -k'` returns nothing. If it returns something "temporary," it's your next ticket.

Get the two directions straight — what you present, what you believe — and every error message on this page becomes a five-minute diagnosis instead of an afternoon.

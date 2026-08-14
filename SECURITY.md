# Security policy

Please report security issues privately through GitHub's security-advisory flow rather than a public
issue.

This project treats all upload metadata and byte streams as untrusted. Implementations must apply
size limits before buffering, must not derive filesystem paths from client filenames, and must bind
every upload resource to an authenticated owner. The protocol package validates syntax only; it does
not authenticate requests or establish that uploaded content is safe to consume.

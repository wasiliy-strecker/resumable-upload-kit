import type { FastifyRequest } from 'fastify'
import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWSAlgorithm,
  type JWTVerifyGetKey,
} from 'jose'

const maximumBearerTokenLength = 16_384
const maximumSubjectLength = 200

export interface AccessTokenVerifier {
  verify(token: string): Promise<string>
}

export interface CreateAccessTokenVerifierOptions {
  readonly algorithms?: readonly JWSAlgorithm[]
  readonly audience: string
  readonly issuer: string
  readonly jwks?: JWTVerifyGetKey
  readonly jwksUrl: string
}

export class AccessTokenRejectedError extends Error {
  public override readonly name = 'AccessTokenRejectedError'
}

export function createAccessTokenVerifier(
  options: CreateAccessTokenVerifierOptions,
): AccessTokenVerifier {
  const key =
    options.jwks ??
    createRemoteJWKSet(new URL(options.jwksUrl), {
      cooldownDuration: 30_000,
      timeoutDuration: 5_000,
    })
  const algorithms: JWSAlgorithm[] = [
    ...(options.algorithms ?? ['RS256', 'PS256', 'ES256', 'EdDSA']),
  ]

  return {
    async verify(token: string): Promise<string> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms,
          audience: options.audience,
          clockTolerance: 5,
          issuer: options.issuer,
          requiredClaims: ['sub', 'iat', 'exp'],
        })
        const subject = payload.sub

        if (
          subject === undefined ||
          subject.length === 0 ||
          subject.length > maximumSubjectLength ||
          subject.trim() !== subject
        ) {
          throw new AccessTokenRejectedError('The access token subject is invalid')
        }

        return subject
      } catch (error) {
        if (error instanceof AccessTokenRejectedError) {
          throw error
        }

        if (isRejectedJoseToken(error)) {
          throw new AccessTokenRejectedError('The access token is invalid', { cause: error })
        }

        throw error
      }
    },
  }
}

export function createOwnerResolver(
  verifier: AccessTokenVerifier,
): (request: FastifyRequest) => Promise<string | null> {
  return async (request) => {
    const token = bearerToken(request.headers.authorization)

    if (token === null) {
      return null
    }

    try {
      return await verifier.verify(token)
    } catch (error) {
      if (error instanceof AccessTokenRejectedError) {
        return null
      }

      throw error
    }
  }
}

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null
  }

  const match = /^Bearer ([^\s]+)$/iu.exec(authorization)
  const token = match?.[1]
  return token !== undefined && token.length <= maximumBearerTokenLength ? token : null
}

function isRejectedJoseToken(error: unknown): boolean {
  return (
    error instanceof joseErrors.JWTClaimValidationFailed ||
    error instanceof joseErrors.JWTExpired ||
    error instanceof joseErrors.JWTInvalid ||
    error instanceof joseErrors.JWSInvalid ||
    error instanceof joseErrors.JWSSignatureVerificationFailed ||
    error instanceof joseErrors.JOSEAlgNotAllowed ||
    error instanceof joseErrors.JWKSNoMatchingKey
  )
}

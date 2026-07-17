import { Module, Logger } from '@nestjs/common';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { LoginAttemptStore } from './login-attempt.store';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.get<string>('JWT_SECRET');
        const nodeEnv = config.get<string>('NODE_ENV');
        // Fail closed everywhere except explicit local dev: require JWT_SECRET unless
        // NODE_ENV==='development'. Tests set JWT_SECRET (NODE_ENV==='test') so they pass.
        if (!secret && nodeEnv !== 'development') {
          throw new Error('JWT_SECRET is required (set it in env). No insecure default outside NODE_ENV=development.');
        }
        // No committed fallback secret. A hardcoded signing key in source (and git history) is a standing
        // liability even if only reachable in dev. When JWT_SECRET is unset in local dev, mint a random
        // ephemeral secret per process instead: dev still works without config, tokens simply reset on
        // restart, and there is never a known signing key in the repo. (Prod cannot reach here — it fails
        // closed above and at the env.validation front door, ITGC-AC-12.)
        const effectiveSecret = secret ?? randomBytes(32).toString('hex');
        if (!secret) {
          new Logger('AuthModule').warn(
            'JWT_SECRET not set (dev) — using a random ephemeral secret; tokens will not survive a restart. ' +
              'Set JWT_SECRET for a stable local session.',
          );
        }
        return {
          secret: effectiveSecret,
          // @nestjs/jwt@11 types expiresIn via ms's StringValue union; our value is a runtime string
          // ('1h' / a seconds count) — cast to satisfy the stricter type without changing behaviour.
          // Short-lived access token (default 1h) — the refresh-token rotation flow (POST /api/auth/refresh,
          // httpOnly refresh cookie) silently renews it, so a stolen access token is only useful for ~1h.
          signOptions: { algorithm: 'HS256', expiresIn: (config.get<string>('JWT_EXPIRES_IN') ?? '1h') as NonNullable<JwtModuleOptions['signOptions']>['expiresIn'] },
          // Pin the accepted algorithm so verification can never be coerced into `alg:none` or an
          // asymmetric-key confusion attack if an RS/ES public key is ever introduced to this module.
          verifyOptions: { algorithms: ['HS256'] },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService, LoginAttemptStore],
  exports: [PasswordService, JwtModule],
})
export class AuthModule {}

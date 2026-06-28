import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

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
        return {
          secret: secret ?? 'dev-only-insecure-secret-change-me',
          signOptions: { algorithm: 'HS256', expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '8h' },
          // Pin the accepted algorithm so verification can never be coerced into `alg:none` or an
          // asymmetric-key confusion attack if an RS/ES public key is ever introduced to this module.
          verifyOptions: { algorithms: ['HS256'] },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  exports: [PasswordService, JwtModule],
})
export class AuthModule {}

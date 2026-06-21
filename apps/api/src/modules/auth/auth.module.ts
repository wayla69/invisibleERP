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
          signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '8h' },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  exports: [PasswordService, JwtModule],
})
export class AuthModule {}

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
        if (!secret && config.get('NODE_ENV') === 'production') {
          throw new Error('JWT_SECRET is required in production (no insecure default — unlike V1).');
        }
        return {
          secret: secret ?? 'dev-only-insecure-secret-change-me',
          signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN') ?? '30d' },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, PasswordService],
  exports: [PasswordService, JwtModule],
})
export class AuthModule {}

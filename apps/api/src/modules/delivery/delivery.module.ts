import { Module } from '@nestjs/common';
import { DeliveryService } from './delivery.service';
import { DeliveryController } from './delivery.controller';
import { DeliveryPdfService } from './delivery-pdf.service';

@Module({ controllers: [DeliveryController], providers: [DeliveryService, DeliveryPdfService], exports: [DeliveryService] })
export class DeliveryModule {}

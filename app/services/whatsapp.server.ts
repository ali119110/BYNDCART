export interface SendWhatsAppInput {
  to: string;
  message: string;
  templateName?: string;
  templateVariables?: Record<string, string>;
}

export interface SendWhatsAppResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface IWhatsAppAdapter {
  providerName: string;
  sendWhatsAppMessage(input: SendWhatsAppInput): Promise<SendWhatsAppResult>;
}

export class MockWhatsAppAdapter implements IWhatsAppAdapter {
  providerName = "MOCK_WHATSAPP";

  async sendWhatsAppMessage(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
    console.log(`[WhatsApp Adapter Mock] Sending WhatsApp message to ${input.to}: ${input.message.slice(0, 50)}...`);
    return {
      success: true,
      messageId: `wa_msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    };
  }
}

class WhatsAppRegistryService {
  private adapter: IWhatsAppAdapter = new MockWhatsAppAdapter();

  public getAdapter(): IWhatsAppAdapter {
    return this.adapter;
  }

  public setAdapter(adapter: IWhatsAppAdapter): void {
    this.adapter = adapter;
  }
}

export const WhatsAppRegistry = new WhatsAppRegistryService();

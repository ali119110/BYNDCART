export class MockWhatsAppAdapter {
  providerName = "MOCK_WHATSAPP";
  async sendWhatsAppMessage(input) {
    console.log(
      `[WhatsApp Adapter Mock] Sending WhatsApp message to ${input.to}: ${input.message.slice(0, 50)}...`,
    );

    return {
      success: true,
      messageId: `wa_msg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    };
  }
}
class WhatsAppRegistryService {
  adapter = new MockWhatsAppAdapter();
  getAdapter() {
    return this.adapter;
  }
  setAdapter(adapter) {
    this.adapter = adapter;
  }
}

export const WhatsAppRegistry = new WhatsAppRegistryService();

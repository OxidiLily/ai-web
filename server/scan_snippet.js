  function scanMessages() {
    if (scanning) return;
    scanning = true;
    try {
      for (const m of getAssistantMsgs()) {
        const container = P.getTurnContainer(m.el);
        processMessageElement(container, m.text);
      }
      for (const m of getUserMsgs()) {
        const container = P.getTurnContainer(m.el);
        processMessageElement(container, m.text);
      }
    } catch (e) {
      log('scan error:', e);
    }
    scanning = false;
  }

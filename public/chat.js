(function() {
  // DOM Elements
  const button = document.getElementById("chat-button");
  const panel = document.getElementById("chat-panel");
  const messages = document.getElementById("messages");
  const input = document.getElementById("user-input");
  const sendBtn = document.getElementById("send-btn");

  let sessionId = localStorage.getItem("pooly-session") || null;
  let sending = false;

  // Toggle chat panel
  button.addEventListener("click", () => {
    panel.classList.toggle("open");
    button.classList.toggle("hide");
    if (panel.classList.contains("open") && messages.children.length === 0) {
      appendMessage("Ciao! Sono PoolyAI, come posso aiutarti oggi?", "ai");
    }
  });

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (panel.classList.contains("open") && 
        !panel.contains(e.target) && 
        !button.contains(e.target)) {
      panel.classList.remove("open");
      button.classList.remove("hide");
      clearMessages();
    }
  });

  // Send message
  async function sendMessage() {
    const text = input.value.trim();
    if (!text || sending) return;

    sending = true;
    sendBtn.disabled = true;

    // Add user message
    appendMessage(text, "me");
    input.value = "";
    input.style.height = "auto";

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          message: text, 
          sessionId: sessionId,
          clientId: getClientId()
        })
      });

      const data = await response.json();

      if (data.sessionId) {
        sessionId = data.sessionId;
        localStorage.setItem("pooly-session", sessionId);
      }

      appendMessage(data.reply, "ai");

    } catch (error) {
      appendMessage("Ops! Problema di connessione. Riprova fra un attimo.", "ai");
      console.error("Chat error:", error);
    } finally {
      sending = false;
      sendBtn.disabled = false;
    }
  }

  // Event listeners
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener("click", sendMessage);

  // Append message to UI
  function appendMessage(text, sender) {
    const div = document.createElement("div");
    div.className = `message ${sender}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  // Clear visible messages (AI keeps memory server-side)
  function clearMessages() {
    messages.innerHTML = "";
  }

  // Simple client ID from URL or random
  function getClientId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("clientId") || "anonymous";
  }

  // Auto-resize input
  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 100) + "px";
  });

})();

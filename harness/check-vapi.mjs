#!/usr/bin/env node
// Read-only Vapi configuration audit. Never creates calls or other billable resources.
const env = process.env;
const required = ["VAPI_API_KEY", "VAPI_ASSISTANT_ID", "VAPI_PHONE_NUMBER_ID"];
const missing = required.filter((name) => !env[name] || env[name].startsWith("your-"));
if (missing.length) {
  console.error("Missing Vapi configuration: " + missing.join(", "));
  process.exit(1);
}

async function get(path) {
  const response = await fetch("https://api.vapi.ai" + path, {
    method: "GET",
    headers: { Authorization: "Bearer " + env.VAPI_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("GET " + path + " returned HTTP " + response.status);
  return response.json();
}

async function main() {
  console.log("Vapi read-only audit: no calls, simulations, or paid operations.");
  const assistant = await get("/assistant/" + encodeURIComponent(env.VAPI_ASSISTANT_ID));
  if (assistant.id !== env.VAPI_ASSISTANT_ID) throw new Error("Assistant ID mismatch");
  const model = assistant.model?.model || "unspecified";
  console.log("Assistant: " + assistant.name + "; model: " + model);
  if (JSON.stringify(assistant.model || {}).includes("gpt-5.2-chat-latest")) {
    throw new Error("Assistant still references retired gpt-5.2-chat-latest");
  }
  if (assistant.modelDeprecations?.length) {
    throw new Error("Assistant has deprecated model configuration: " +
      assistant.modelDeprecations.map((x) => x.slot + "=" + x.model).join(", "));
  }

  const phone = await get("/phone-number/" + encodeURIComponent(env.VAPI_PHONE_NUMBER_ID));
  if (phone.id !== env.VAPI_PHONE_NUMBER_ID) throw new Error("Phone-number ID mismatch");
  if (assistant.orgId && phone.orgId && assistant.orgId !== phone.orgId) {
    throw new Error("Assistant and phone number belong to different organizations");
  }
  console.log("Phone number: " + (phone.provider || "unknown") + "; status: " + (phone.status || "not reported"));
  if (phone.status && phone.status !== "active") console.warn("Check non-active phone-number status in Vapi.");
  if (phone.assistantId && phone.assistantId !== assistant.id) {
    console.warn("Inbound calls on this number route to a different assistant.");
  }
  if (phone.provider === "vapi") {
    console.warn("Confirm this number supports outbound calls; free Vapi numbers are inbound-only.");
  }
  console.log("Configuration lookups passed. Real call/telephony operation remains untested.");
}

main().catch((error) => {
  console.error("Vapi audit failed: " + error.message);
  process.exitCode = 1;
});

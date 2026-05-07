export default function Home() {
  return (
    <main style={{ fontFamily: "Arial, sans-serif", maxWidth: 760, margin: "60px auto", padding: 24 }}>
      <h1>Stripe Damage Deposit Discord Tool</h1>
      <p>This Vercel app handles Discord slash commands and creates Stripe manual-capture authorisation holds.</p>
      <h2>Endpoint</h2>
      <code>/api/discord</code>
      <h2>Commands</h2>
      <ul>
        <li><code>/create-hold amount:300 portal_link:https://...</code></li>
        <li><code>/release-hold payment_intent_id:pi_...</code></li>
        <li><code>/capture-hold payment_intent_id:pi_... amount:200</code></li>
      </ul>
      <p>Keep your Stripe and Discord secrets inside Vercel Environment Variables, not in the code.</p>
    </main>
  );
}

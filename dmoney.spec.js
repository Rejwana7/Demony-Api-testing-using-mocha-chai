import { expect } from "chai";
import { describe, it, before } from "mocha";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const BASE_URL = process.env.BASE_URL;
const PARTNER_KEY = process.env.PARTNER_KEY;
const DEFAULT_OTP = process.env.DEFAULT_OTP;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SYSTEM_EMAIL = process.env.SYSTEM_EMAIL;
const SYSTEM_PASSWORD = process.env.SYSTEM_PASSWORD;

// Business rule constants (mirrors the Postman collection's own test scripts)
const AGENT_COMMISSION_RATE = 0.025; // 2.5% commission earned by agent on deposit
const SEND_MONEY_FEE = 5; // flat fee for customer-to-customer send money
const PERCENT_FEE_RATE = 0.01; // 1% fee (withdraw / merchant payment), minimum 5 Tk
const MIN_FEE = 5;
const SYSTEM_DEPOSIT_AMOUNT = 5000;
const AGENT_DEPOSIT_AMOUNT = 2000;
const SEND_MONEY_AMOUNT = 1000;
const CASH_OUT_AMOUNT = 500;
const PAYMENT_AMOUNT = 400;

const percentFee = (amount) => Math.max(amount * PERCENT_FEE_RATE, MIN_FEE);

// Single axios instance; validateStatus never throws so every status code
// (2xx/4xx) can be asserted explicitly instead of relying on try/catch.
const api = axios.create({
  baseURL: BASE_URL,
  timeout: 15000,
  validateStatus: () => true,
});

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildUser(role, tag) {
  // Timestamp + random component keeps this unique across repeated test runs,
  // not just within a single run (a 4-digit-only suffix collided across runs).
  const suffix = `${Date.now().toString().slice(-7)}${randomInt(10, 99)}`;
  return {
    name: `Test ${role} ${suffix}`,
    email: `rejwanatabassum87871+${tag}+${suffix}@gmail.com`,
    password: "1234",
    phone_number: `0120${randomInt(1000000, 9999999)}`,
    nid: `${randomInt(1000000000, 9999999999)}`,
    role,
  };
}

function authHeaders(token, includePartnerKey = true) {
  const headers = { Authorization: `bearer ${token}` };
  if (includePartnerKey) headers["X-AUTH-SECRET-KEY"] = PARTNER_KEY;
  return headers;
}

// The backend rejects unknown fields on /user/create, so only the raw
// profile fields may be sent - not the runtime token/balance/id we track.
function toCreatePayload(user) {
  const { name, email, password, phone_number, nid, role } = user;
  return { name, email, password, phone_number, nid, role };
}

// Shared state across the whole suite, mirroring Postman collection variables.
// Balances are tracked locally so fee/commission assertions are computed,
// not hardcoded, while still pinning down an exact expected value.
const state = {
  admin: { token: null },
  system: { token: null },
  agent: { ...buildUser("Agent", "agent"), token: null, balance: 0 },
  customer1: { ...buildUser("Customer", "customer1"), token: null, balance: 0 },
  customer2: { ...buildUser("Customer", "customer2"), token: null, balance: 0 },
  merchant: { ...buildUser("Merchant", "merchant"), token: null, balance: 0 },
};

// Registers `describe(title) -> before(run) -> it(...) for each check`.
// Collapses the repeated "let response; before(); it(); it(); ..." boilerplate
// into one declarative call per scenario, without changing any request or
// assertion. `onResponse`, if given, runs once right after the request
// (used to capture ids/tokens or update the local balance ledger).
function scenario(title, run, checks, onResponse) {
  describe(title, () => {
    let response;
    before(async () => {
      response = await run();
      if (onResponse) onResponse(response);
    });
    for (const [name, assertion] of Object.entries(checks)) {
      it(name, () => assertion(response));
    }
  });
}

// The "create user" + "activate user" pair is identical for all four roles,
// only the state key and role name change.
function provisionUser(key, role) {
  const user = state[key];

  scenario(
    `Create ${role} (${key})`,
    () => api.post("/user/create", toCreatePayload(user), { headers: authHeaders(state.admin.token) }),
    {
      "returns status 201": (res) => expect(res.status).to.equal(201),
      "returns 'User created' message": (res) => expect(res.data.message).to.equal("User created"),
      [`creates the user with role '${role}'`]: (res) => expect(res.data.user.role).to.equal(role),
      "creates the user with status 'pending'": (res) => expect(res.data.user.status).to.equal("pending"),
      "persists the correct email, phone number and NID": (res) => {
        expect(res.data.user.email).to.equal(user.email);
        expect(res.data.user.phone_number).to.equal(user.phone_number);
        expect(res.data.user.nid).to.equal(user.nid);
      },
    },
    (res) => {
      if (res.data?.user?.id) user.id = res.data.user.id;
    }
  );

  scenario(
    `Activate ${role} (${key})`,
    () => api.patch(`/user/update/${user.id}`, { status: "active" }, { headers: authHeaders(state.admin.token) }),
    {
      "returns status 200": (res) => expect(res.status).to.equal(200),
      "returns 'User updated successfully' message": (res) => expect(res.data.message).to.equal("User updated successfully"),
      "updates the user status to 'active'": (res) => expect(res.data.user.status).to.equal("active"),
    }
  );
}

// Shared "login (sends OTP) -> verify OTP (returns token)" happy path used
// by Customer 1, Customer 2 and Merchant. Agent keeps its own scenarios
// instead of using this helper: it also exercises wrong-password/wrong-OTP
// checks interleaved between login and verify, and the wrong-OTP check only
// gets the right error (401 "Invalid OTP") if it runs after a real login has
// already sent an OTP - so that order can't be collapsed into this helper.
function otpLogin(key, label) {
  scenario(
    `${label} login`,
    () => api.post("/user/login?env=dev", { email: state[key].email, password: "1234" }),
    {
      "returns status 200": (res) => expect(res.status).to.equal(200),
      "sends an OTP": (res) => expect(res.data.message.toLowerCase()).to.include("otp"),
    }
  );

  scenario(
    `${label} verify OTP`,
    () => api.post("/user/verify-otp?env=dev", { identifier: state[key].email, otp: DEFAULT_OTP }),
    {
      "returns status 200": (res) => expect(res.status).to.equal(200),
      "returns a non-empty token": (res) => {
        expect(res.data.token).to.be.a("string");
        expect(res.data.token.length).to.be.greaterThan(0);
      },
    },
    (res) => {
      state[key].token = res.data.token;
    }
  );
}

describe("Dmoney API Integration Assignment", function () {
  this.timeout(20000);

  describe("Admin", () => {
    scenario(
      "Login with invalid password",
      () => api.post("/user/login", { email: ADMIN_EMAIL, password: "wrong-password" }),
      {
        "returns status 401": (res) => expect(res.status).to.equal(401),
        "returns 'Password incorrect' message": (res) => expect(res.data.message).to.equal("Password incorrect"),
      }
    );

    scenario(
      "Login with valid credentials",
      () => api.post("/user/login", { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "returns 'Login successful' message": (res) => expect(res.data.message).to.equal("Login successful"),
        "returns a non-empty token": (res) => {
          expect(res.data.token).to.be.a("string");
          expect(res.data.token.length).to.be.greaterThan(0);
        },
        "returns role 'Admin'": (res) => expect(res.data.role).to.equal("Admin"),
      },
      (res) => {
        state.admin.token = res.data.token;
      }
    );

    provisionUser("customer1", "Customer");

    scenario(
      "Duplicate user creation is rejected",
      () =>
        api.post(
          "/user/create",
          {
            name: "Duplicate Test User",
            email: state.customer1.email,
            password: "1234",
            phone_number: "01201112222",
            nid: "1234567890",
            role: "Customer",
          },
          { headers: authHeaders(state.admin.token) }
        ),
      {
        "returns status 208": (res) => expect(res.status).to.equal(208),
        "returns 'User already exists' message": (res) => expect(res.data.message).to.equal("User already exists"),
      }
    );

    provisionUser("customer2", "Customer");
    provisionUser("agent", "Agent");
    provisionUser("merchant", "Merchant");
  });

  describe("System", () => {
    scenario(
      "Login with valid credentials",
      () => api.post("/user/login", { email: SYSTEM_EMAIL, password: SYSTEM_PASSWORD }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "returns a login success message": (res) => expect(res.data.message.toLowerCase()).to.include("login"),
        "returns a non-empty token": (res) => {
          expect(res.data.token).to.be.a("string");
          expect(res.data.token.length).to.be.greaterThan(0);
        },
      },
      (res) => {
        state.system.token = res.data.token;
      }
    );

    scenario(
      "Deposit to agent with invalid token",
      () =>
        api.post(
          "/transaction/deposit",
          { from_account: "SYSTEM", to_account: state.agent.phone_number, amount: SYSTEM_DEPOSIT_AMOUNT },
          { headers: authHeaders("abc123") }
        ),
      {
        "returns status 403": (res) => expect(res.status).to.equal(403),
        "returns 'Token invalid!' message": (res) => expect(res.data.message).to.equal("Token invalid!"),
      }
    );

    scenario(
      "Deposit to agent with invalid partner secret key",
      () =>
        api.post(
          "/transaction/deposit",
          { from_account: "SYSTEM", to_account: state.agent.phone_number, amount: SYSTEM_DEPOSIT_AMOUNT },
          { headers: { Authorization: `bearer ${state.system.token}`, "X-AUTH-SECRET-KEY": "wrong-key" } }
        ),
      {
        "returns status 401": (res) => expect(res.status).to.equal(401),
        "returns 'Secret auth key validation failure!' message": (res) =>
          expect(res.data.message).to.equal("Secret auth key validation failure!"),
      }
    );

    scenario(
      "Deposit 5000 Tk to Agent",
      () =>
        api.post(
          "/transaction/deposit",
          { from_account: "SYSTEM", to_account: state.agent.phone_number, amount: SYSTEM_DEPOSIT_AMOUNT },
          { headers: authHeaders(state.system.token) }
        ),
      {
        "returns status 201": (res) => expect(res.status).to.equal(201),
        "returns 'SYSTEM deposit to Agent successful' message": (res) =>
          expect(res.data.message).to.equal("SYSTEM deposit to Agent successful"),
        "returns a non-empty transaction id": (res) => {
          expect(res.data.trnxId).to.be.a("string");
          expect(res.data.trnxId.length).to.be.greaterThan(0);
        },
        "deposits the exact requested amount": (res) => expect(res.data.amount).to.equal(SYSTEM_DEPOSIT_AMOUNT),
        "returns the updated agent balance": (res) => expect(res.data.agentBalance).to.equal(state.agent.balance),
      },
      (res) => {
        if (res.status === 201) state.agent.balance += SYSTEM_DEPOSIT_AMOUNT;
      }
    );
  });

  describe("Agent", () => {
    scenario(
      "Login with correct credentials",
      () => api.post("/user/login?env=dev", { email: state.agent.email, password: "1234" }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "sends an OTP": (res) => expect(res.data.message.toLowerCase()).to.include("otp"),
      }
    );

    scenario(
      "Verify OTP with wrong code",
      () => api.post("/user/verify-otp?env=dev", { identifier: state.agent.email, otp: "11111" }),
      {
        "returns status 401": (res) => expect(res.status).to.equal(401),
        "returns 'Invalid OTP. Please try again.' message": (res) =>
          expect(res.data.message).to.equal("Invalid OTP. Please try again."),
      }
    );

    scenario(
      "Verify OTP with correct code",
      () => api.post("/user/verify-otp?env=dev", { identifier: state.agent.email, otp: DEFAULT_OTP }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "confirms the login": (res) => expect(res.data.message.toLowerCase()).to.match(/otp|login/),
        "returns a non-empty token": (res) => {
          expect(res.data.token).to.be.a("string");
          expect(res.data.token.length).to.be.greaterThan(0);
        },
      },
      (res) => {
        state.agent.token = res.data.token;
      }
    );

    scenario(
      "Deposit 2000 Tk to Customer 1",
      () =>
        api.post(
          "/transaction/deposit",
          { from_account: state.agent.phone_number, to_account: state.customer1.phone_number, amount: AGENT_DEPOSIT_AMOUNT },
          { headers: authHeaders(state.agent.token) }
        ),
      {
        "returns status 201": (res) => expect(res.status).to.equal(201),
        "returns 'Deposit successful' message": (res) => expect(res.data.message).to.equal("Deposit successful"),
        "returns a non-empty transaction id": (res) => {
          expect(res.data.trnxId).to.be.a("string");
          expect(res.data.trnxId.length).to.be.greaterThan(0);
        },
        "charges the agent a 2.5% commission": (res) =>
          expect(res.data.commission).to.equal(AGENT_DEPOSIT_AMOUNT * AGENT_COMMISSION_RATE),
        "returns the agent's updated current balance": (res) => {
          expect(res.data.currentBalance).to.be.a("number");
          expect(res.data.currentBalance).to.equal(state.agent.balance);
        },
      },
      (res) => {
        if (res.status === 201) {
          state.agent.balance = state.agent.balance - AGENT_DEPOSIT_AMOUNT + res.data.commission;
          state.customer1.balance += AGENT_DEPOSIT_AMOUNT;
        }
      }
    );

    scenario(
      "Check agent balance",
      () => api.get(`/transaction/balance/${state.agent.phone_number}`, { headers: authHeaders(state.agent.token) }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "returns the agent's current balance": (res) => expect(res.data.balance).to.equal(state.agent.balance),
      }
    );

    scenario(
      "Deposit fails with insufficient balance",
      () =>
        api.post(
          "/transaction/deposit",
          { from_account: state.agent.phone_number, to_account: state.customer1.phone_number, amount: 6000 }, // deliberately over balance
          { headers: authHeaders(state.agent.token) }
        ),
      {
        "returns status 208": (res) => expect(res.status).to.equal(208),
        "returns 'Insufficient balance' message": (res) => expect(res.data.message).to.equal("Insufficient balance"),
        "returns the current (unchanged) balance": (res) => expect(res.data.currentBalance).to.equal(state.agent.balance),
      }
    );

    scenario(
      "Deposit fails for a non-existent customer account",
      () =>
        api.post(
          "/transaction/deposit",
          { from_account: state.agent.phone_number, to_account: "01201234598", amount: 2000 },
          { headers: authHeaders(state.agent.token) }
        ),
      {
        "returns status 404": (res) => expect(res.status).to.equal(404),
        "returns 'To Account does not exist' message": (res) => expect(res.data.message).to.equal("To Account does not exist"),
      }
    );
  });

  describe("Customer", () => {
    otpLogin("customer1", "Customer 1");

    scenario(
      "Customer 1 sends 1000 Tk to Customer 2",
      () =>
        api.post(
          "/transaction/sendmoney",
          { from_account: state.customer1.phone_number, to_account: state.customer2.phone_number, amount: SEND_MONEY_AMOUNT },
          { headers: authHeaders(state.customer1.token) }
        ),
      {
        "returns status 201": (res) => expect(res.status).to.equal(201),
        "returns a send money success message": (res) => expect(res.data.message.toLowerCase()).to.include("send"),
        "returns a non-empty transaction id": (res) => {
          expect(res.data.trnxId).to.be.a("string");
          expect(res.data.trnxId.length).to.be.greaterThan(0);
        },
        "charges a flat 5 Tk service fee": (res) => expect(res.data.fee).to.equal(SEND_MONEY_FEE),
        "returns Customer 1's updated current balance": (res) => expect(res.data.currentBalance).to.equal(state.customer1.balance),
      },
      (res) => {
        if (res.status === 201) {
          state.customer1.balance -= SEND_MONEY_AMOUNT + SEND_MONEY_FEE;
          state.customer2.balance += SEND_MONEY_AMOUNT;
        }
      }
    );

    scenario(
      "Send money fails when the daily limit is exceeded",
      () =>
        api.post(
          "/transaction/sendmoney",
          { from_account: state.customer1.phone_number, to_account: state.customer2.phone_number, amount: 4000 },
          { headers: authHeaders(state.customer1.token) }
        ),
      {
        "returns status 400": (res) => expect(res.status).to.equal(400),
        "returns a daily limit exceeded message": (res) => expect(res.data.message).to.include("Daily amount limit exceeded"),
        "reports the amount already used against today's limit": (res) =>
          expect(res.data.details.usedAmount).to.equal(SEND_MONEY_AMOUNT + SEND_MONEY_FEE), // only the earlier successful send counts
        "reports the remaining allowance for today": (res) =>
          expect(res.data.details.remainingAmount).to.equal(res.data.details.maxAmount - (SEND_MONEY_AMOUNT + SEND_MONEY_FEE)),
      }
    );

    scenario(
      "Check Customer 1 balance",
      () => api.get(`/transaction/balance/${state.customer1.phone_number}`, { headers: authHeaders(state.customer1.token) }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "returns Customer 1's current balance": (res) => expect(res.data.balance).to.equal(state.customer1.balance),
      }
    );

    otpLogin("customer2", "Customer 2");

    scenario(
      "Customer 2 cashes out 500 Tk from the Agent",
      () =>
        api.post(
          "/transaction/withdraw",
          { from_account: state.customer2.phone_number, to_account: state.agent.phone_number, amount: CASH_OUT_AMOUNT },
          { headers: authHeaders(state.customer2.token) }
        ),
      {
        "returns status 201": (res) => expect(res.status).to.equal(201),
        "returns 'Withdraw successful' message": (res) => expect(res.data.message).to.equal("Withdraw successful"),
        "returns a non-empty transaction id": (res) => {
          expect(res.data.trnxId).to.be.a("string");
          expect(res.data.trnxId.length).to.be.greaterThan(0);
        },
        "charges 1% of the amount (minimum 5 Tk) as service fee": (res) => expect(res.data.fee).to.equal(percentFee(CASH_OUT_AMOUNT)),
        "returns Customer 2's updated current balance": (res) => expect(res.data.currentBalance).to.equal(state.customer2.balance),
      },
      (res) => {
        if (res.status === 201) state.customer2.balance -= CASH_OUT_AMOUNT + percentFee(CASH_OUT_AMOUNT);
      }
    );

    scenario(
      "Check Customer 2 balance",
      () => api.get(`/transaction/balance/${state.customer2.phone_number}`, { headers: authHeaders(state.customer2.token) }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "returns Customer 2's current balance": (res) => expect(res.data.balance).to.equal(state.customer2.balance),
      }
    );
  });

  describe("Merchant", () => {
    scenario(
      "Customer 2 pays 400 Tk to the Merchant",
      () =>
        api.post(
          "/transaction/payment",
          { from_account: state.customer2.phone_number, to_account: state.merchant.phone_number, amount: PAYMENT_AMOUNT },
          { headers: authHeaders(state.customer2.token) }
        ),
      {
        "returns status 201": (res) => expect(res.status).to.equal(201),
        "returns 'Payment successful' message": (res) => expect(res.data.message).to.equal("Payment successful"),
        "returns a non-empty transaction id": (res) => {
          expect(res.data.trnxId).to.be.a("string");
          expect(res.data.trnxId.length).to.be.greaterThan(0);
        },
        "deducts 1% of the amount (minimum 5 Tk) as service fee from the customer": (res) =>
          expect(res.data.fee).to.equal(percentFee(PAYMENT_AMOUNT)),
        "returns Customer 2's updated current balance after the fee deduction": (res) =>
          expect(res.data.currentBalance).to.equal(state.customer2.balance),
      },
      (res) => {
        if (res.status === 201) {
          state.customer2.balance -= PAYMENT_AMOUNT + percentFee(PAYMENT_AMOUNT);
          state.merchant.balance += PAYMENT_AMOUNT;
        }
      }
    );

    scenario(
      "Payment fails with a negative amount",
      () =>
        api.post(
          "/transaction/payment",
          { from_account: state.customer2.phone_number, to_account: state.merchant.phone_number, amount: -400 },
          { headers: authHeaders(state.customer2.token) }
        ),
      {
        "returns status 400": (res) => expect(res.status).to.equal(400),
        "returns an invalid amount message": (res) =>
          expect(res.data.message).to.equal("Amount must be a valid number greater than 0"),
      }
    );

    scenario(
      "Payment fails when paying yourself",
      () =>
        api.post(
          "/transaction/payment",
          { from_account: state.customer2.phone_number, to_account: state.customer2.phone_number, amount: 600 },
          { headers: authHeaders(state.customer2.token) }
        ),
      {
        "returns status 400": (res) => expect(res.status).to.equal(400),
        "returns a same account message": (res) =>
          expect(res.data.message).to.equal("From account and to account cannot be the same"),
      }
    );

    otpLogin("merchant", "Merchant");

    scenario(
      "Check Merchant balance",
      () => api.get(`/transaction/balance/${state.merchant.phone_number}`, { headers: authHeaders(state.merchant.token) }),
      {
        "returns status 200": (res) => expect(res.status).to.equal(200),
        "reflects the payment received from Customer 2": (res) => expect(res.data.balance).to.equal(state.merchant.balance),
      }
    );
  });
});

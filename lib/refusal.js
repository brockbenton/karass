// An error whose message is safe and useful to show to whoever asked.
class Refusal extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

module.exports = Refusal;

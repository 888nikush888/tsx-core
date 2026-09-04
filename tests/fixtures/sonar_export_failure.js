// This preload guarantees subprocess error-redaction tests never use a network.
globalThis.fetch = async () => {
  throw new Error(`authorization: Bearer ${process.env.SONAR_TOKEN}`, {
    cause: new Error(`https://sonarcloud.example/api?secret=${process.env.SONAR_TOKEN}`)
  });
};

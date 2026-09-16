// This preload guarantees subprocess error-redaction tests never use a network.
// skipcq: JS-0116 - this fixture must reject asynchronously like the API it simulates.
globalThis.fetch = async () => {
  throw new Error(`authorization: Bearer ${process.env.SONAR_TOKEN}`, {
    cause: new Error(`https://sonarcloud.example/api?secret=${process.env.SONAR_TOKEN}`)
  });
};

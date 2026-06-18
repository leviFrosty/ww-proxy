/** Any App Attest verification failure. Maps to a 401 at the route layer. */
export class AppAttestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AppAttestError'
  }
}

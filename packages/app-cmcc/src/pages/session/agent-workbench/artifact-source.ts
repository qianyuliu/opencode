export type AgentArtifactContent = {
  loaded: boolean
  loading?: boolean
  error?: string
  text?: string
}

export type AgentArtifactSource = {
  get: (path: string) => AgentArtifactContent | undefined
  load: (path: string) => Promise<void>
  download: (path: string) => Promise<Blob>
  previewUrl: (path: string) => string | undefined
}

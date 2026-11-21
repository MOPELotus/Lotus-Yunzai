export interface WebLoginSettings {
  enable: boolean;
  public_url: string;
  path: string;
  ticket_minutes: number;
  session_hours: number;
  panel_ticket_minutes: number;
  panel_session_hours: number;
}

export interface WebLoginSnapshot {
  revision: string;
  settings: WebLoginSettings;
}

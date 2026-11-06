import "@fontsource-variable/inter"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "./styles.css"
import "./warroom/warroom.css"
import "../../shared/theme.css"
import "./after-hours.css"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { WalletProvider } from "./wallet"
import { WebApp } from "./WebApp"

createRoot(document.getElementById("root")!).render(
  <StrictMode><WalletProvider><WebApp /></WalletProvider></StrictMode>,
)

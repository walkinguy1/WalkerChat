"""WebRTC support endpoints.

Signaling itself does NOT live here. Offers, answers, ICE candidates and
hangups travel as `WebRTCSignalEvent` over the existing chat socket at
`/api/ws/chat`, which already authenticates the user, verifies chat membership,
and fans out through Redis Pub/Sub.

An earlier version of this module opened a second WebSocket at
`/api/webrtc/signaling`. That could never work: WebSocket tickets are
single-use and consumed on connect (see `core/security.consume_ws_ticket`), so
the second socket had no valid credential, and registering it in the shared
ConnectionManager corrupted first/last-connection presence tracking.

What remains here is the ICE server lookup the browser needs before it can
build an RTCPeerConnection.
"""

from fastapi import APIRouter, Depends

from app.core.config import get_settings
from app.core.security import get_current_user
from app.models.user import User
from app.schemas.media import IceConfigResponse, IceServer

router = APIRouter()
settings = get_settings()


@router.get("/ice-config", response_model=IceConfigResponse)
async def get_ice_config(
    _: User = Depends(get_current_user),
) -> IceConfigResponse:
    """ICE servers for call setup.

    STUN alone is enough on a LAN or on localhost. Peers behind symmetric NAT
    need a TURN relay; set WEBRTC_TURN_URL / WEBRTC_TURN_USERNAME /
    WEBRTC_TURN_CREDENTIAL to supply one.
    """
    ice_servers = [IceServer(urls=list(settings.webrtc_stun_urls))]

    if settings.webrtc_turn_url:
        ice_servers.append(
            IceServer(
                urls=[settings.webrtc_turn_url],
                username=settings.webrtc_turn_username or None,
                credential=settings.webrtc_turn_credential or None,
            )
        )

    return IceConfigResponse(ice_servers=ice_servers)

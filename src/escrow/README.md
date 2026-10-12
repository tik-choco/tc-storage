portable core copied verbatim from tc-linkai src/escrow @ ad7e330; keep byte-identical, vector tests must pass
Joining an app room with the same ID as an escrow room is a misconfiguration: the controller reports the collision and Custom mode warns; broader app-room collision enforcement is deferred.

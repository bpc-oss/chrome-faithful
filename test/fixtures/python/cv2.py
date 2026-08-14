IMREAD_COLOR = 1


def imdecode(data, mode):
    if mode != IMREAD_COLOR or not data:
        return None
    return {"decoded_bytes": len(data)}

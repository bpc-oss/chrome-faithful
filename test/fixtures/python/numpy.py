uint8 = object()


def frombuffer(data, dtype):
    if dtype is not uint8:
        raise AssertionError("adapter must decode bytes as uint8")
    return data

class Config(dict):
    """Works exactly like a dict but provides ways to fill it from files."""

    def from_mapping(self, mapping):
        self.update(mapping)
        return True

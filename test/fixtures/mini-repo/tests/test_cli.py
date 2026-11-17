from app.cli import main


class TestRoutes:
    def test_routes(self):
        assert main() is not None

import click


@click.command("routes")
def routes_command():
    """Show the routes for the app."""
    click.echo("routes")


@click.command("shell")
def shell_command():
    """Run a shell in the app context."""
    click.echo("shell")


def main():
    cli = click.Group()
    cli.add_command(routes_command)
    cli.add_command(shell_command)
    return cli

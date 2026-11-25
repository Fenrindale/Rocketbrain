package mixed.fixture;

public final class JavaApplication {
    public static String execute(int number) {
        KotlinGateway gateway = new KotlinGateway();
        return gateway.transform(number) + ":" + gateway.getName();
    }

    public static void main(String[] args) {
        System.out.println(execute(7));
    }
}

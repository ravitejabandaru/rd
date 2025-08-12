from lxml import etree as ET
import os

# Namespaces from your file
NS = {
    'm': "http://soap.sforce.com/2006/04/metadata",
    'xsi': "http://www.w3.org/2001/XMLSchema-instance",
    'xsd': "http://www.w3.org/2001/XMLSchema"
}

xml_directory = r"force-app\main\default\customMetadata"

# Your list of interfaces
interfaces = ["AddAccountHold"]

def update_xml_file(file_path):
    parser = ET.XMLParser(remove_blank_text=False)  # preserve whitespace
    tree = ET.parse(file_path, parser)
    root = tree.getroot()

    # Find value node for DD_inbound__c
    xpath = "//m:values[m:field='DD_inbound__c']/m:value"
    values = root.xpath(xpath, namespaces=NS)
    if not values:
        print(f"Field not found in {file_path}")
        return

    value = values[0]
    # Remove xsi:nil if present
    value.attrib.pop(f"{{{NS['xsi']}}}nil", None)
    # Ensure type is boolean
    value.set(f"{{{NS['xsi']}}}type", "xsd:boolean")
    # Set to true
    value.text = "true"

    # Write back without pretty print → minimal diff
    tree.write(file_path, encoding='UTF-8', xml_declaration=True, pretty_print=False)

    print(f"Updated: {file_path}")

def update_interfaces():
    for interface in interfaces:
        file_name = f"DD_integrationEndPoint.{interface}__md-meta.xml"
        file_path = os.path.join(xml_directory, file_name)
        if os.path.exists(file_path):
            update_xml_file(file_path)
        else:
            print(f"File not found: {file_path}")

if __name__ == "__main__":
    update_interfaces()